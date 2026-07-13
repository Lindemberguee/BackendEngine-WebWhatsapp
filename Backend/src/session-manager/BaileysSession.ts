import makeWASocket, {
  DisconnectReason,
  type WASocket,
  type AnyMessageContent,
  type WAMessage,
  type Contact as BaileysContact,
  type GroupMetadata,
  makeCacheableSignalKeyStore,
} from '@webwhatsapp/engine';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { Types } from 'mongoose';
import { useMongoAuthState } from './MongoAuthState';
import { Instance, Conversation, Message, Contact } from '../db/models';
import type { WebSocketGateway } from '../ws/gateway';
import { extractMessageContent, parseJid, extractMediaMetadata, extractPreview, lastMessagePreview } from '../utils/message.utils';
import { handleInboundForFlows } from '../flow-executor';
import { inspectMediaMessage } from '../utils/media-inspector';
import { maybeAutoCreateLeadFromConversation } from '../modules/crm/crm.service';
import { notify, notifyWorkspaceOwner } from '../modules/notifications/notification.service';
import { backfillRecipientDeliveryStatus, handleCampaignReply } from '../modules/campaigns/campaign.service';
import { getAutoRouteMode, routeConversation } from '../modules/routing/routing.service';
import { applySlaTimers } from '../modules/routing/sla.service';
import { emitWebhookEvent } from '../modules/webhooks/webhook.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const OPT_OUT_KEYWORDS = new Set(['parar', 'sair', 'stop', 'cancelar', 'unsubscribe']);

/**
 * Strip the device/agent suffix from a JID so the same user coming from a linked
 * device ("5511999:2@s.whatsapp.net") converges on the canonical user JID
 * ("5511999@s.whatsapp.net") instead of splitting into a duplicate conversation.
 */
function stripDeviceSuffix(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0].split('_')[0];
  return `${user}@${jid.slice(at + 1)}`;
}

export type SessionEvent =
  | { type: 'status'; instanceId: string; status: string; qrCode?: string; pairingCode?: string; phone?: string }
  | { type: 'message'; instanceId: string; workspaceId: string; message: Record<string, unknown> }
  | { type: 'presence'; instanceId: string; workspaceId: string; jid: string; presence: string };

export class BaileysSession {
  private sock?: WASocket;
  private reconnectAttempts = 0;
  private destroyed = false;
  private connected = false;
  private workspaceId!: string;
  private groupSubjectCache = new Map<string, { subject: string; ts: number }>();

  constructor(
    public readonly instanceId: string,
    private readonly wsGateway: WebSocketGateway
  ) {}

  async connect(): Promise<void> {
    const instanceDoc = await Instance.findById(this.instanceId);
    if (!instanceDoc) throw new Error(`Instance ${this.instanceId} not found`);
    this.workspaceId = instanceDoc.workspaceId.toString();

    await Instance.findByIdAndUpdate(this.instanceId, { status: 'connecting', errorMessage: undefined });
    this.wsGateway.broadcastInstanceStatus(this.workspaceId, this.instanceId, 'connecting');

    const { state, saveCreds } = await useMongoAuthState(this.instanceId);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1]),
      },
      printQRInTerminal: false,
      logger: logger.child({ instanceId: this.instanceId }) as unknown as Parameters<typeof makeWASocket>[0]['logger'],
      defaultQueryTimeoutMs: 60_000,
      browser: ['WebWhatsapp', 'Chrome', '127.0.0'],
    });

    // ── Connection state ────────────────────────────────────────────────────
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const QRCode = await import('qrcode');
        const qrBase64 = await QRCode.toDataURL(qr);
        await Instance.findByIdAndUpdate(this.instanceId, { status: 'qr_pending', qrCode: qrBase64 });
        this.wsGateway.broadcastInstanceStatus(this.workspaceId, this.instanceId, 'qr_pending', { qrCode: qrBase64 });
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.connected = true;
        const phone = this.sock?.user?.id?.split(':')[0] ?? undefined;
        await Instance.findByIdAndUpdate(this.instanceId, {
          status: 'connected',
          qrCode: undefined,
          pairingCode: undefined,
          errorMessage: undefined,
          lastConnectedAt: new Date(),
          phone,
        });
        this.wsGateway.broadcastInstanceStatus(this.workspaceId, this.instanceId, 'connected', { phone });
        logger.info({ instanceId: this.instanceId, phone }, 'Instance connected');
        notifyWorkspaceOwner(this.wsGateway, this.workspaceId, {
          type: 'instance.connected', title: 'WhatsApp conectado',
          message: `O número ${phone} foi conectado com sucesso`,
          link: '/instances', metadata: { instanceId: this.instanceId },
        }).catch(() => {});
      }

      if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        await Instance.findByIdAndUpdate(this.instanceId, {
          status: loggedOut ? 'disconnected' : 'error',
          lastDisconnectedAt: new Date(),
          errorMessage: loggedOut ? undefined : String(lastDisconnect?.error ?? 'Unknown error'),
        });
        this.wsGateway.broadcastInstanceStatus(this.workspaceId, this.instanceId, loggedOut ? 'disconnected' : 'error');
        notifyWorkspaceOwner(this.wsGateway, this.workspaceId, {
          type: 'instance.disconnected', title: 'WhatsApp desconectado',
          message: loggedOut ? 'A instância foi desconectada (logout no aparelho).' : 'A instância caiu por um erro de conexão.',
          link: '/instances', metadata: { instanceId: this.instanceId },
        }).catch(() => {});

        if (!loggedOut && !this.destroyed) {
          this.reconnectAttempts++;
          const delay = Math.min(3000 * this.reconnectAttempts, 30_000);
          logger.warn({ instanceId: this.instanceId, attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
          setTimeout(() => this.connect(), delay);
        }
      }
    });

    // ── Credentials ────────────────────────────────────────────────────────
    this.sock.ev.on('creds.update', saveCreds);

    // ── Messages ───────────────────────────────────────────────────────────
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        // 'notify' = new inbound message (always process).
        // 'append' = echo of a message WE sent (e.g. flow runner, manual reply).
        //   The engine fires 'append' — not 'notify' — for outbound messages, so
        //   we MUST handle it here or flow/agent replies never appear in the chat.
        //   Guard: only process recent fromMe echoes to avoid re-importing the full
        //   history-sync batch that arrives on reconnect.
        if (type === 'append') {
          if (!msg.key.fromMe) continue;
          const msgTs = (msg.messageTimestamp as number ?? 0) * 1000;
          if (Date.now() - msgTs > 5 * 60_000) continue; // skip if older than 5 min
        } else if (type !== 'notify') {
          continue;
        }
        try {
          await this.processIncomingMessage(msg);
        } catch (err) {
          logger.error({ err, msgId: msg.key.id }, 'Failed to process message');
        }
      }
    });

    // ── Message status updates ─────────────────────────────────────────────
    this.sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (update.update.status !== undefined) {
          const statusMap: Record<number, string> = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
          const newStatus = statusMap[update.update.status as number];
          if (newStatus) {
            // Resolve to the Mongo _id + conversationId the frontend cache is keyed by
            // (update.key.id is the WhatsApp message id, not our document id).
            const doc = await Message.findOneAndUpdate(
              { messageId: update.key.id },
              { status: newStatus },
              { new: true }
            );
            if (doc) {
              this.wsGateway.broadcastToWorkspace(this.workspaceId, 'message:status', {
                conversationId: doc.conversationId.toString(),
                messageId: doc._id.toString(),
                status: newStatus,
              });
              if (newStatus === 'sent' || newStatus === 'delivered' || newStatus === 'read') {
                backfillRecipientDeliveryStatus(update.key.id as string, newStatus).catch(() => {});
              }
            }
          }
        }
      }
    });

    // ── Presence ───────────────────────────────────────────────────────────
    // Broadcasts: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
    this.sock.ev.on('presence.update', ({ id, presences }) => {
      const firstPresence = Object.values(presences)[0];
      if (firstPresence) {
        const presence = firstPresence.lastKnownPresence;

        // Map WhatsApp presence to our enum
        const presenceMap: Record<string, string> = {
          'available': 'online',
          'unavailable': 'offline',
          'composing': 'typing',
          'recording': 'recording',
          'paused': 'offline',
        };

        this.wsGateway.broadcastToWorkspace(this.workspaceId, 'presence.update', {
          jid: id,
          phone: parseJid(id),
          presence: presenceMap[presence] ?? presence, // Fallback to raw if unmapped
          timestamp: new Date().toISOString(),
        });
      }
    });

    // ── Contacts (profile pictures, names) ──────────────────────────────────
    this.sock.ev.on('contacts.upsert', async (contacts: BaileysContact[]) => {
      for (const contact of contacts) {
        try {
          const { id: jid, imgUrl, notify } = contact;
          const phone = parseJid(jid);

          // Update Contact with avatar + metadata
          await Contact.findOneAndUpdate(
            { workspaceId: this.workspaceId, jid },
            {
              $set: {
                avatarUrl: imgUrl ?? undefined,
                // notify is their WhatsApp display name
                ...(notify ? { pushName: notify } : {}),
              },
            },
            { upsert: true, new: true }
          );

          // Sync to 1:1 conversation: if avatar or name changed, update conversation too
          if (imgUrl !== undefined || notify) {
            const conversationUpdates: Record<string, unknown> = {};
            if (imgUrl !== undefined) conversationUpdates.avatarUrl = imgUrl ?? undefined;
            if (notify) conversationUpdates.name = notify;

            const updatedConversations = await Conversation.find(
              { workspaceId: this.workspaceId, jid, isGroup: false },
            );
            await Conversation.updateMany(
              { workspaceId: this.workspaceId, jid, isGroup: false },
              { $set: conversationUpdates }
            );

            // Broadcast avatar/name update to frontend so it re-renders without a page refresh
            for (const conv of updatedConversations) {
              this.wsGateway.broadcastToWorkspace(this.workspaceId, 'conversation:updated', {
                conversationId: conv._id.toString(),
                avatarUrl: imgUrl ?? undefined,
                ...(notify ? { name: notify } : {}),
              });
            }
          }

          logger.debug({ jid, phone, hasAvatar: !!imgUrl }, 'Contact updated');
        } catch (err) {
          logger.warn({ err, contactId: contact.id }, 'Failed to process contact update');
        }
      }
    });

    // ── Groups (metadata, participants) ────────────────────────────────────
    this.sock.ev.on('groups.upsert', async (groups: GroupMetadata[]) => {
      for (const group of groups) {
        try {
          const jid = group.id;
          const phone = parseJid(jid);

          // Build participant list
          const participants = group.participants.map((p) => ({
            jid: p.id,
            phone: parseJid(p.id),
            name: p.name,
            isAdmin: p.isAdmin ?? false,
            isSuperAdmin: p.isSuperAdmin ?? false,
          }));

          // Upsert conversation with group info
          await Conversation.findOneAndUpdate(
            { workspaceId: this.workspaceId, instanceId: this.instanceId, jid, isGroup: true },
            {
              $set: {
                name: group.subject,
                phone,
                groupInfo: {
                  subject: group.subject,
                  picture: group.picture,
                  description: group.desc,
                  participantCount: participants.length,
                  ownerId: group.owner,
                  isReadOnly: group.announce ?? false,
                  adminOnly: group.restrict ?? false,
                  isCommunity: group.isCommunity ?? false,
                  participants,
                  createdAt: group.creation ? new Date(group.creation * 1000) : undefined,
                },
              },
              $setOnInsert: {
                workspaceId: this.workspaceId,
                instanceId: this.instanceId,
                jid,
                isGroup: true,
                phone,
              },
            },
            { upsert: true, new: true }
          );

          logger.debug({ jid, subject: group.subject, members: participants.length }, 'Group updated');
        } catch (err) {
          logger.warn({ err, groupId: group.id }, 'Failed to process group update');
        }
      }
    });

    // ── Message Reactions ─────────────────────────────────────────────────────
    this.sock.ev.on('messages.reaction', async (reactions) => {
      for (const { key, reaction } of reactions) {
        try {
          const msgId = reaction.key?.id;
          const emoji = reaction.text;  // Falsey if removed
          const reactionSender = key.participant || key.remoteJid;

          if (!msgId || !reactionSender) continue;

          const msg = await Message.findOne({ workspaceId: this.workspaceId, messageId: msgId });
          if (!msg) continue; // Can't react to a message we don't have

          const phone = parseJid(reactionSender);
          const reactionTs = new Date((reaction.timestamp || Math.floor(Date.now() / 1000)) * 1000);

          if (emoji) {
            // Add or update reaction
            msg.reactions = msg.reactions || [];
            const existing = msg.reactions.find((r) => r.jid === reactionSender);
            if (existing) {
              existing.emoji = emoji;
              existing.timestamp = reactionTs;
            } else {
              msg.reactions.push({ emoji, jid: reactionSender, phone, timestamp: reactionTs });
            }
          } else {
            // Remove reaction (emoji is falsey when user removes reaction)
            msg.reactions = msg.reactions?.filter((r) => r.jid !== reactionSender) || [];
          }

          await msg.save();

          // Broadcast reaction change to all connected clients
          this.wsGateway.broadcastToWorkspace(this.workspaceId, 'message:reactions-update', {
            conversationId: msg.conversationId.toString(),
            messageId: msg._id.toString(),
            reactions: msg.reactions || [],
          });

          logger.debug({ msgId, emoji, reactionSender }, 'Reaction processed');
        } catch (err) {
          logger.warn({ err }, 'Failed to process reaction');
        }
      }
    });

    // ── Group participants ─────────────────────────────────────────────────────
    this.sock.ev.on('group-participants.update', async ({ id: jid, participants, action }) => {
      try {
        // Refresh group metadata to get full participant list
        const groupMeta = await this.sock?.groupMetadata(jid);
        if (!groupMeta) return;

        const updatedParticipants = groupMeta.participants.map((p) => ({
          jid: p.id,
          phone: parseJid(p.id),
          name: p.name,
          isAdmin: p.isAdmin ?? false,
          isSuperAdmin: p.isSuperAdmin ?? false,
        }));

        await Conversation.findOneAndUpdate(
          { workspaceId: this.workspaceId, jid, isGroup: true },
          { $set: { 'groupInfo.participants': updatedParticipants, 'groupInfo.participantCount': updatedParticipants.length } }
        );

        logger.debug({ jid, action, updatedCount: updatedParticipants.length }, 'Group participants updated');
      } catch (err) {
        logger.warn({ err, jid, action }, 'Failed to process group participants update');
      }
    });

    // ── Chat Metadata (archived, pinned, muted) ───────────────────────────────
    this.sock.ev.on('chats.upsert', async (chats) => {
      for (const chat of chats) {
        try {
          // Only update if metadata actually changed (avoid unnecessary writes)
          const chatMetadata = {
            archived: chat.archived ?? false,
            pinnedPosition: (chat.pinned ?? 0) > 0 ? chat.pinned : undefined,
            muteExpiredAt: chat.muteEnd
              ? (chat.muteEnd === 0 ? null : new Date(chat.muteEnd * 1000))
              : undefined,
            archivedAt: chat.archived ? new Date() : undefined,
          };

          await Conversation.findOneAndUpdate(
            { workspaceId: this.workspaceId, jid: stripDeviceSuffix(chat.id) },
            { $set: { chatMetadata } }
          );

          logger.debug(
            { jid: chat.id, archived: chat.archived, pinned: chat.pinned, muted: !!chat.muteEnd },
            'Chat metadata updated'
          );
        } catch (err) {
          logger.warn({ err, chatId: chat.id }, 'Failed to process chat metadata');
        }
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async sendMessage(jid: string, content: AnyMessageContent, options?: unknown): Promise<WAMessage | undefined> {
    if (!this.sock) throw new Error('Instance not connected');
    return this.sock.sendMessage(jid, content, options as Parameters<WASocket['sendMessage']>[2]);
  }

  /** Checks whether phone JIDs are actually registered on WhatsApp — used by campaigns to skip dead numbers before spending a send slot on them. */
  async checkOnWhatsApp(...jids: string[]): Promise<Array<{ exists: boolean; jid: string }> | undefined> {
    if (!this.sock) throw new Error('Instance not connected');
    const sockWithCheck = this.sock as WASocket & { onWhatsApp?: (...jids: string[]) => Promise<Array<{ exists: boolean; jid: string }>> };
    return sockWithCheck.onWhatsApp?.(...jids);
  }

  /**
   * Ask WhatsApp to re-upload media for a message whose CDN URL expired. Used as the
   * `reuploadRequest` for downloadMediaMessage so old media can still be fetched.
   */
  get updateMediaMessage(): WASocket['updateMediaMessage'] | undefined {
    return this.sock?.updateMediaMessage.bind(this.sock);
  }

  /** True when the socket exists and the WhatsApp connection is open. */
  isReady(): boolean {
    return this.connected && !!this.sock;
  }

  /** Wait until the connection is open, up to timeoutMs. Returns false on timeout. */
  async waitUntilReady(timeoutMs = 8000): Promise<boolean> {
    if (this.isReady()) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isReady()) return true;
      if (this.destroyed) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.isReady();
  }

  async requestPairingCode(phone: string): Promise<string> {
    if (!this.sock) throw new Error('Instance not connected');
    const code = await this.sock.requestPairingCode(phone);
    await Instance.findByIdAndUpdate(this.instanceId, {
      status: 'pairing_pending',
      pairingCode: code,
    });
    this.wsGateway.broadcastInstanceStatus(this.workspaceId, this.instanceId, 'pairing_pending', { pairingCode: code });
    return code;
  }

  async logout(): Promise<void> {
    this.destroyed = true;
    try { await this.sock?.logout(); } catch { /* ignore */ }
    this.sock = undefined;
    await Instance.findByIdAndUpdate(this.instanceId, {
      status: 'disconnected',
      authCreds: undefined,
      authKeys: undefined,
      qrCode: undefined,
    });
  }

  disconnect(): void {
    this.destroyed = true;
    this.sock?.end(undefined);
    this.sock = undefined;
  }

  isConnected(): boolean {
    return this.sock?.user !== undefined;
  }

  async subscribePresence(jid: string): Promise<void> {
    await this.sock?.presenceSubscribe(jid);
  }

  // ── Message processing ─────────────────────────────────────────────────────

  /**
   * WhatsApp may address the same contact with two different JID formats:
   *   - phone-number JID:  "5511999@s.whatsapp.net"  (used for OUR outbound sends)
   *   - LID (privacy) JID: "240114458476559@lid"     (used by WhatsApp for inbound)
   * If we keyed conversations by the raw JID, the same person would split into two
   * conversations. We normalize every "@lid" back to its phone-number JID so inbound
   * and outbound always converge on a single conversation.
   */
  private async normalizeJid(jid: string, msg: WAMessage): Promise<string> {
    let out = jid;

    // 1) LID (privacy) JID → phone-number JID
    if (jid.endsWith('@lid')) {
      // WhatsApp attaches the alternate (phone-number) JID directly on the key
      const alt = (msg.key as { remoteJidAlt?: string }).remoteJidAlt;
      if (alt && alt.endsWith('@s.whatsapp.net')) {
        out = alt;
      } else {
        // Fall back to the engine's LID → PN mapping store
        try {
          const repo = this.sock?.signalRepository as
            | { lidMapping?: { getPNForLID(lid: string): Promise<string | null> } }
            | undefined;
          const pn = await repo?.lidMapping?.getPNForLID(jid);
          if (pn) out = pn;
        } catch (err) {
          logger.warn({ err, jid }, 'LID→PN resolution failed');
        }
      }
    }

    // 2) Drop the device/agent suffix (e.g. "5511999:2@s.whatsapp.net" from a
    //    linked device / the phone as companion) so every device of the same
    //    contact maps to ONE conversation.
    return stripDeviceSuffix(out);
  }

  /**
   * Resolve a group's subject (display name), cached for a few minutes to avoid
   * hammering the WhatsApp metadata endpoint on every message.
   */
  private async getGroupSubject(jid: string): Promise<string | null> {
    const cached = this.groupSubjectCache.get(jid);
    if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.subject;
    try {
      const meta = await this.sock?.groupMetadata(jid);
      const subject = meta?.subject;
      if (subject) {
        this.groupSubjectCache.set(jid, { subject, ts: Date.now() });
        return subject;
      }
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to fetch group metadata');
    }
    return null;
  }

  private async processIncomingMessage(msg: WAMessage): Promise<void> {
    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid === 'status@broadcast') return;

    const messageId = msg.key.id;
    if (!messageId) return;

    // Idempotency: Baileys can deliver the same message more than once (notify +
    // history/append, or after a reconnect). Skip if we've already stored it — this
    // prevents the E11000 unique-key crash AND double-counting unreadCount below.
    const already = await Message.exists({ workspaceId: this.workspaceId, messageId });
    if (already) return;

    const jid = await this.normalizeJid(rawJid, msg);

    const { type, content, text } = extractMessageContent(msg);

    // Skip phantom/protocol stubs that carry no displayable content. WhatsApp often
    // delivers a null-message, messageContextInfo-only, or protocol/key-distribution
    // event (commonly as the FIRST event when a chat is opened or a session resyncs).
    // Storing these creates empty "unknown" bubbles. A real unknown-type message still
    // carries displayable content keys; a stub only has protocol metadata.
    const PROTOCOL_ONLY_KEYS = new Set([
      'messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage',
    ]);
    const displayableKeys = Object.keys(content).filter((k) => !PROTOCOL_ONLY_KEYS.has(k));
    if (type === 'unknown' && !text && displayableKeys.length === 0) {
      logger.debug({ messageId, jid }, 'Skipping empty/protocol message stub');
      return;
    }

    // Inspect media to understand what Engine provides
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
      inspectMediaMessage(msg);
    }

    // Extract media metadata (duration, dimensions, thumbnails, etc)
    const mediaMetadata = extractMediaMetadata(msg);
    const contentWithMedia = {
      ...content,
      ...mediaMetadata[type],  // Merge type-specific metadata into content
    };

    // Extract quoted message context (if this message is a reply)
    let quotedContext;
    const quotedMessageId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ??
                            msg.message?.imageMessage?.contextInfo?.stanzaId ??
                            msg.message?.videoMessage?.contextInfo?.stanzaId ??
                            msg.message?.audioMessage?.contextInfo?.stanzaId ??
                            msg.message?.documentMessage?.contextInfo?.stanzaId;

    if (quotedMessageId) {
      const quotedMsg = await Message.findOne({ workspaceId: this.workspaceId, messageId: quotedMessageId });
      if (quotedMsg) {
        quotedContext = {
          messageId: quotedMsg._id.toString(),
          type: quotedMsg.type,
          preview: extractPreview(quotedMsg),
          senderName: quotedMsg.senderName || (quotedMsg.fromMe ? 'Você' : undefined),
          timestamp: quotedMsg.createdAt,
        };
        logger.debug({ quotedMessageId, preview: quotedContext.preview }, 'Quoted message found');
      }
    }

    const isGroup = jid.endsWith('@g.us');
    const phone = parseJid(jid);

    // For groups: conversation name is the group subject, and senderName is who sent this message.
    // For 1:1: conversation name is the contact's name (from pushName if inbound, or saved Contact).
    // NOTE: msg.pushName is the sender's name. For outbound messages, that's the AGENT, not the contact.
    // So for outbound to a new contact, we can't trust pushName — we'll get it from Contact or use phone.

    const senderName = msg.pushName ?? phone; // Message-level: who sent this specific message
    let conversationName: string;

    if (isGroup) {
      conversationName = (await this.getGroupSubject(jid)) ?? `Grupo ${phone.slice(-4)}`;
    } else {
      // 1:1 conversation name: try Contact first, then pushName, then phone
      // (pushName is unreliable for outbound messages to new contacts)
      const savedContact = await Contact.findOne({ workspaceId: this.workspaceId, jid }).lean();
      if (savedContact?.name) {
        conversationName = savedContact.name;
      } else if (!msg.key.fromMe && msg.pushName) {
        // Only trust pushName for inbound messages
        conversationName = msg.pushName;
      } else {
        conversationName = phone;
      }
    }

    // Upsert conversation — use workspaceId+jid as the primary key so that manually-created
    // conversations (which have no instanceId) are found and updated rather than triggering
    // a duplicate-key error from the { workspaceId, jid } sparse unique index.
    const conversation = await Conversation.findOneAndUpdate(
      { workspaceId: this.workspaceId, jid },
      {
        $setOnInsert: { workspaceId: this.workspaceId, jid, isGroup, phone },
        $set: {
          instanceId: this.instanceId,
          name: conversationName,
          lastMessage: { content: lastMessagePreview(type, text), type, direction: msg.key.fromMe ? 'outbound' : 'inbound', timestamp: new Date((msg.messageTimestamp as number) * 1000) },
          ...(msg.key.fromMe ? {} : { status: 'open' }),
        },
        $inc: { unreadCount: msg.key.fromMe ? 0 : 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // A fresh upsert has createdAt === updatedAt to the millisecond; used below to
    // gate one-time actions (e.g. CRM auto-lead-creation) to brand-new conversations only.
    const isNewConversation = conversation.createdAt.getTime() === conversation.updatedAt.getTime();

    // Opt-in auto-routing: workspaces that want every new inbound conversation routed
    // immediately (rather than waiting for a bot handoff to a human) set autoRoute='on_new'.
    if (isNewConversation && !isGroup && !msg.key.fromMe) {
      getAutoRouteMode(this.workspaceId).then((mode) => {
        if (mode === 'on_new') void routeConversation(conversation._id.toString(), this.wsGateway);
      }).catch(() => {});
    }

    // Every inbound customer message opens/reopens the ticket — start the SLA
    // clock if the queue/workspace has one configured and none is already running.
    if (!isGroup && !msg.key.fromMe) {
      void applySlaTimers(conversation._id.toString(), this.workspaceId, conversation.teamGroupId?.toString());
      void emitWebhookEvent(this.workspaceId, 'message.received', {
        conversationId: conversation._id.toString(), phone, text, type,
      });
    }

    // Campaign opt-out keyword — a plain-text reply of just "PARAR"/"SAIR"/"STOP"/"CANCELAR"
    // excludes the contact from every future campaign audience. Doesn't affect normal
    // 1:1 support messaging, only bulk/campaign sends (see resolveAudience()).
    if (!isGroup && !msg.key.fromMe && OPT_OUT_KEYWORDS.has(text.trim().toLowerCase())) {
      Contact.updateOne({ workspaceId: this.workspaceId, jid }, { $set: { optedOutAt: new Date() } }).catch(() => {});
    }

    // Campaign reply tracking — if this contact received a campaign message recently and
    // hasn't replied yet, mark it and auto-create a CRM lead (see handleCampaignReply).
    if (!isGroup && !msg.key.fromMe && conversation.contactId) {
      handleCampaignReply(this.workspaceId, jid, conversation._id.toString(), conversation.contactId.toString()).catch(() => {});
    }

    // Notify the assigned agent, but only on the message that makes the conversation go
    // from "caught up" to "has something new" (unreadCount just became 1) — not on every
    // message of an already-unread conversation, which would spam a notification per message.
    if (!isGroup && !msg.key.fromMe && conversation.assignedAgentId && conversation.unreadCount === 1) {
      notify(this.wsGateway, {
        workspaceId: this.workspaceId, recipientId: conversation.assignedAgentId.toString(),
        type: 'conversation.message', title: 'Nova mensagem recebida',
        message: `${conversationName}: ${lastMessagePreview(type, text)}`,
        link: '/conversations', metadata: { conversationId: conversation._id.toString() },
      }).catch(() => {});
    }

    // Upsert contact (1:1 only — groups aren't contacts)
    // For new contacts from outbound messages, don't assume senderName is the contact's name
    // (it's the agent's name). Only set name from pushName for inbound.
    if (!isGroup) {
      const contactName = msg.key.fromMe ? phone : (msg.pushName ?? phone);
      const contactUpdates: Record<string, unknown> = {
        $setOnInsert: {
          workspaceId: this.workspaceId,
          jid,
          phone,
          name: contactName,
        },
      };

      // Update lastSeenAt and pushName for inbound messages
      if (!msg.key.fromMe) {
        contactUpdates.$set = {
          lastSeenAt: new Date((msg.messageTimestamp as number) * 1000),
          // Update pushName from inbound message if available
          ...(msg.pushName ? { pushName: msg.pushName } : {}),
        };
      }

      const savedContact = await Contact.findOneAndUpdate(
        { workspaceId: this.workspaceId, jid },
        contactUpdates,
        { upsert: true, new: true }
      );

      // Link the contact to this conversation if not already linked
      if (savedContact && conversation && !conversation.contactId) {
        await Conversation.updateOne(
          { _id: conversation._id, contactId: { $exists: false } },
          { $set: { contactId: savedContact._id } }
        );
      }

      // CRM: auto-create a lead for brand-new inbound conversations, if a pipeline opted in.
      if (isNewConversation && !msg.key.fromMe && savedContact) {
        maybeAutoCreateLeadFromConversation(this.workspaceId, conversation._id, savedContact._id, savedContact.name)
          .catch((err) => logger.warn({ err }, '[crm] auto-create lead failed'));
      }

      // Proactively fetch profile picture for new contacts (fire-and-forget)
      const sock = this.sock;
      if (sock && savedContact && !savedContact.avatarUrl) {
        const wsGateway = this.wsGateway;
        const workspaceId = this.workspaceId;
        const contactId = savedContact._id;
        // Engine's .d.ts types profilePictureUrl as (jid) only, but Baileys accepts
        // (jid, 'image' | 'preview') at runtime — 'image' returns the full-res photo.
        (sock.profilePictureUrl as (jid: string, type?: 'image' | 'preview') => Promise<string>)(jid, 'image')
          .then(async (picUrl) => {
            if (!picUrl) return;
            await Contact.updateOne({ _id: contactId }, { $set: { avatarUrl: picUrl } });
            const updatedConvs = await Conversation.find({ workspaceId, jid });
            await Conversation.updateMany({ workspaceId, jid }, { $set: { avatarUrl: picUrl } });
            for (const conv of updatedConvs) {
              wsGateway.broadcastToWorkspace(workspaceId, 'conversation:updated', {
                conversationId: conv._id.toString(),
                avatarUrl: picUrl,
              });
            }
            logger.debug({ jid, picUrl }, 'Avatar fetched and saved');
          })
          .catch(() => { /* contact privacy blocks picture — ignore */ });
      }
    }

    // For media messages, pre-generate message ID so we can embed the proxy URL.
    // NOTE: set the URL on `contentWithMedia` (the object actually persisted) — not
    // on `content`, which was already spread into contentWithMedia above.
    const msgObjectId = new Types.ObjectId();
    const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
    if (mediaTypes.includes(type)) {
      (contentWithMedia as Record<string, unknown>).url =
        `/api/conversations/${conversation._id}/messages/${msgObjectId}/media`;
    }

    // For group messages: extract sender JID from msg.key.participant (who sent this message)
    const senderJid = isGroup && !msg.key.fromMe ? msg.key.participant : undefined;
    const senderPhoneFromJid = senderJid ? parseJid(senderJid) : undefined;

    // Save message. Guard against the rare race where two concurrent deliveries
    // both clear the exists() check above — the unique index rejects the second,
    // which we swallow instead of crashing.
    let savedMsg;
    try {
      savedMsg = await Message.create({
        _id: msgObjectId,
        workspaceId: this.workspaceId,
        instanceId: this.instanceId,
        conversationId: conversation._id,
        jid,
        messageId,
        direction: msg.key.fromMe ? 'outbound' : 'inbound',
        type,
        status: msg.key.fromMe ? 'sent' : 'delivered',
        fromMe: msg.key.fromMe ?? false,
        content: contentWithMedia,  // Includes media metadata
        quoted: quotedContext,      // Quoted message context (if reply)
        // Attribute the sender for inbound group messages so the UI can show who spoke.
        senderName: isGroup && !msg.key.fromMe ? senderName : undefined,
        senderJid,
        senderPhone: senderPhoneFromJid,
        rawPayload: msg as unknown as Record<string, unknown>,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return; // duplicate — already stored
      throw err;
    }

    // Broadcast to frontend via WS — shape must match the frontend Message contract
    // (the REST adapter maps createdAt → timestamp; we mirror that here).
    this.wsGateway.broadcastToWorkspace(this.workspaceId, 'message:new', {
      conversationId: conversation._id.toString(),
      message: {
        id: savedMsg._id.toString(),
        conversationId: conversation._id.toString(),
        type: savedMsg.type,
        content: {
          ...savedMsg.content,
          // Extract media-specific metadata to top-level for UI convenience
          ...(type === 'audio' && savedMsg.content.audio ? { audio: savedMsg.content.audio } : {}),
          ...(type === 'video' && savedMsg.content.video ? { video: savedMsg.content.video } : {}),
          ...(type === 'image' && savedMsg.content.image ? { image: savedMsg.content.image } : {}),
        },
        direction: savedMsg.direction,
        status: savedMsg.status,
        timestamp: savedMsg.createdAt.toISOString(),
        senderName: savedMsg.senderName,
        senderJid: savedMsg.senderJid,
        senderPhone: savedMsg.senderPhone,
        quoted: savedMsg.quoted,    // Include quoted message context
      },
    });

    // ── Flow automation: trigger flows on inbound messages (1:1 and groups) ──
    // Group flows are disabled by default; a flow can opt-in via trigger.allowGroups.
    if (!msg.key.fromMe && this.sock) {
      const sock = this.sock;
      handleInboundForFlows({
        workspaceId: this.workspaceId,
        instanceId: this.instanceId,
        isGroup,
        conversation: { _id: conversation._id, contactId: conversation.contactId, name: conversation.name, phone: conversation.phone, jid },
        contact: { name: conversation.name, phone: conversation.phone },
        text: text ?? '',
        msg,
        sendMessage: this.makeFlowSend(),
        sendPresence: async (j, state) => { await sock.sendPresenceUpdate(state, j); },
        wsGateway: this.wsGateway,
      }).catch((err) => logger.warn({ err }, '[flow] inbound handler failed'));
    }
  }

  /**
   * Wraps sock.sendMessage so that every message a flow runner sends is
   * explicitly stored and broadcast even if the 'append' event arrives late
   * or is missed. processIncomingMessage is idempotent (Message.exists guard).
   */
  private makeFlowSend() {
    const sock = this.sock;
    if (!sock) throw new Error('Session not connected');
    return async (j: string, content: AnyMessageContent) => {
      const result = await sock.sendMessage(j, content as never);
      if (result) {
        this.processIncomingMessage(result).catch((err) =>
          logger.warn({ err }, '[flow] failed to store sent message')
        );
      }
      return result;
    };
  }

  /**
   * Start a flow run outside the normal inbound-message path — used by
   * server-side events (e.g. a CRM lead changing stage) that need to run a
   * flow against an existing conversation without a triggering WA message.
   */
  async triggerFlow(
    flowDoc: import('../db/models').IFlow,
    params: {
      conversationId: string; jid: string; contact: { name?: string; phone?: string };
      /** Extra variables to seed the run with (e.g. a webhook trigger's custom payload fields) — available as {{chave}} in the flow. */
      _inheritedVariables?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.sock) return;
    const sock = this.sock;
    const { FlowRunner } = await import('../flow-executor');
    const runner = new FlowRunner({
      sendMessage: this.makeFlowSend(),
      sendPresence: async (j, state) => { await sock.sendPresenceUpdate(state, j); },
      wsGateway: this.wsGateway,
    });
    await runner.start(flowDoc, {
      workspaceId: this.workspaceId,
      instanceId: this.instanceId,
      conversationId: params.conversationId,
      jid: params.jid,
      contact: params.contact,
      _inheritedVariables: params._inheritedVariables,
    });
  }
}
