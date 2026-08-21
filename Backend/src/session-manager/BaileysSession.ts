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
import { useMongoAuthState } from './MongoAuthState';
import { Instance, Conversation, Message, Contact } from '../db/models';
import type { WebSocketGateway } from '../ws/gateway';
import { extractMessageContent, parseJid, extractMediaMetadata, extractPreview } from '../utils/message.utils';
import { inspectMediaMessage } from '../utils/media-inspector';
import { notifyWorkspaceOwner } from '../modules/notifications/notification.service';
import { backfillRecipientDeliveryStatus } from '../modules/campaigns/campaign.service';
import { ingestInboundMessage } from '../messaging/ingest-inbound';
import { toBaileys } from '../channels/baileys/to-baileys';
import type { OutboundMessage } from '../messaging/outbound-types';
import type { IChannelSession } from '../channels/types';
import { archiveMessageMedia } from '../shared/media-storage';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

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

export class BaileysSession implements IChannelSession {
  readonly channel = 'baileys' as const;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private sock?: WASocket;
  private reconnectAttempts = 0;
  private destroyed = false;
  private connected = false;
  private workspaceId!: string;
  private groupSubjectCache = new Map<string, { subject: string; ts: number }>();

  constructor(
    public readonly instanceId: string,
    private readonly wsGateway: WebSocketGateway,
    /** Called when WhatsApp itself ends the session (phone-side logout) — lets
     *  SessionManager evict this instance from its map even when nobody called
     *  logoutSession() explicitly, so a later re-pair doesn't hit a corpse. */
    private readonly onLoggedOut?: () => void
  ) {}

  async connect(): Promise<void> {
    // Guard against overlapping connect() calls — a pending reconnect timer
    // firing while another connect() is already in flight (or a manual restart
    // racing a reconnect) would otherwise leave two live sockets both wired to
    // `this`, both writing instance status and both scheduling their own
    // reconnects (a reconnect storm). Tear down any previous socket first.
    if (this.sock) {
      const staleSock = this.sock;
      this.sock = undefined;
      // end() already tears down the engine's own listeners/timers/noise state
      // internally (see socket.js's end()) — no need to duplicate that here.
      try { staleSock.end(undefined); } catch { /* best-effort */ }
    }

    const instanceDoc = await Instance.findById(this.instanceId);
    if (!instanceDoc) throw new Error(`Instance ${this.instanceId} not found`);
    this.workspaceId = instanceDoc.workspaceId.toString();

    // `$set: { errorMessage: undefined }` is silently dropped by the Mongo driver —
    // it does NOT clear the field, so a stale error from a previous failed attempt
    // stuck around forever once one occurred. Needs an actual $unset.
    await Instance.findByIdAndUpdate(this.instanceId, { $set: { status: 'connecting' }, $unset: { errorMessage: 1 } });
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
      try {
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
        // Same undefined-doesn't-clear pitfall — the old QR/pairing code and any
        // stale error message never actually left the document, and kept being
        // returned by GET /api/instances for an instance that's now connected.
        await Instance.findByIdAndUpdate(this.instanceId, {
          $set: { status: 'connected', lastConnectedAt: new Date(), phone },
          $unset: { qrCode: 1, pairingCode: 1, errorMessage: 1 },
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
        // forbidden (403, number banned/blocked by WhatsApp) and connectionReplaced
        // (440, another web session took over) are explicitly documented as
        // "don't reconnect" cases — retrying just hammers WhatsApp's servers every
        // 30s forever and can make a ban worse. badSession (500) means the stored
        // auth state itself is corrupt; reconnecting with the same broken creds
        // just repeats the same failure indefinitely. All three need a human to
        // act (re-scan a fresh QR / contact support), not an infinite retry loop.
        const terminalCode = statusCode === DisconnectReason.forbidden
          || statusCode === DisconnectReason.connectionReplaced
          || statusCode === DisconnectReason.badSession;
        const isBanned = statusCode === DisconnectReason.forbidden;

        const status = loggedOut ? 'disconnected' : isBanned ? 'banned' : 'error';
        // Same undefined-doesn't-clear pitfall as above: on a clean logout the old
        // errorMessage from a previous failed attempt needs an actual $unset, or it
        // stays displayed even though the instance is now just cleanly disconnected.
        await Instance.findByIdAndUpdate(this.instanceId, loggedOut
          ? { $set: { status, lastDisconnectedAt: new Date() }, $unset: { errorMessage: 1 } }
          : { $set: { status, lastDisconnectedAt: new Date(), errorMessage: String(lastDisconnect?.error ?? 'Unknown error') } });
        this.wsGateway.broadcastInstanceStatus(this.workspaceId, this.instanceId, status);
        notifyWorkspaceOwner(this.wsGateway, this.workspaceId, {
          type: 'instance.disconnected', title: 'WhatsApp desconectado',
          message: loggedOut
            ? 'A instância foi desconectada (logout no aparelho).'
            : isBanned
            ? 'O número foi bloqueado pelo WhatsApp.'
            : terminalCode
            ? 'A instância caiu e precisa ser reconectada manualmente.'
            : 'A instância caiu por um erro de conexão.',
          link: '/instances', metadata: { instanceId: this.instanceId },
        }).catch(() => {});

        if (loggedOut || terminalCode) {
          this.destroyed = true;
          if (loggedOut) this.onLoggedOut?.();
        } else if (!this.destroyed) {
          this.reconnectAttempts++;
          // Cap the backoff loop too — a transient-looking failure that's still
          // failing after 10 attempts (~5 min of backoff) is no longer transient;
          // stop hammering and let the user retry manually instead of looping forever.
          if (this.reconnectAttempts > BaileysSession.MAX_RECONNECT_ATTEMPTS) {
            logger.error({ instanceId: this.instanceId }, 'Giving up reconnect after max attempts');
            this.destroyed = true;
            return;
          }
          const delay = Math.min(3000 * this.reconnectAttempts, 30_000);
          logger.warn({ instanceId: this.instanceId, attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
          setTimeout(() => {
            // Re-check at fire time, not just when the timer was scheduled — the
            // session may have been explicitly logged out/disconnected in the
            // interim, and resurrecting it here would deliver messages through
            // an untracked orphan session (SessionManager no longer knows about it).
            if (this.destroyed) return;
            this.connect().catch((err) => logger.error({ err, instanceId: this.instanceId }, 'Reconnect attempt failed'));
          }, delay);
        }
      }
      } catch (err) {
        logger.error({ err, instanceId: this.instanceId }, 'Failed to handle connection.update');
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
        try {
          if (update.update.status !== undefined) {
            const statusMap: Record<number, string> = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
            const newStatus = statusMap[update.update.status as number];
            if (newStatus) {
              // Resolve to the Mongo _id + conversationId the frontend cache is keyed by
              // (update.key.id is the WhatsApp message id, not our document id).
              //
              // Scoped by workspaceId — messageId alone isn't unique across tenants (our
              // fallback id for a not-yet-acked send is `temp_${Date.now()}`, which two
              // workspaces can generate in the same millisecond), so an unscoped query
              // could update, and then broadcast, another workspace's message.
              //
              // $in guards against a late/out-of-order status event downgrading an
              // already-more-advanced status (e.g. a delayed 'sent' arriving after 'read').
              const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };
              const notLowerRank = Object.entries(STATUS_RANK)
                .filter(([, rank]) => rank <= STATUS_RANK[newStatus])
                .map(([s]) => s);
              const doc = await Message.findOneAndUpdate(
                { messageId: update.key.id, workspaceId: this.workspaceId, status: { $in: notLowerRank } },
                { status: newStatus },
                { new: true }
              );
              if (doc) {
                const parentConv = await Conversation.findById(doc.conversationId).select('assignedAgentId').lean();
                this.wsGateway.broadcastToConversationVisibility(this.workspaceId, parentConv?.assignedAgentId?.toString(), 'message:status', {
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
        } catch (err) {
          logger.error({ err, msgId: update.key.id }, 'Failed to process message status update');
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
              this.wsGateway.broadcastToConversationVisibility(this.workspaceId, conv.assignedAgentId?.toString(), 'conversation:updated', {
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
    this.sock.ev.on('group-participants.update', async ({ id: jid, action }) => {
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
          // chats.upsert payloads are partial — a field being absent means "unchanged
          // on WhatsApp's side", not "false/cleared". The old code always overwrote the
          // *entire* chatMetadata object (defaulting absent fields to false/undefined),
          // so any manually-set mute/archive from our own UI (conversations.routes.ts's
          // /mute and /archive endpoints) got silently wiped by the next sync tick.
          // Only touch the specific dot-paths WhatsApp actually reported.
          const setFields: Record<string, unknown> = {};
          if (chat.archived !== undefined) {
            setFields['chatMetadata.archived'] = chat.archived;
            setFields['chatMetadata.archivedAt'] = chat.archived ? new Date() : undefined;
          }
          if (chat.pinned !== undefined) {
            setFields['chatMetadata.pinnedPosition'] = chat.pinned > 0 ? chat.pinned : undefined;
          }
          if (chat.muteEnd !== undefined) {
            setFields['chatMetadata.muteExpiredAt'] = chat.muteEnd === 0 ? null : new Date(chat.muteEnd * 1000);
          }
          if (Object.keys(setFields).length === 0) continue;

          await Conversation.findOneAndUpdate(
            { workspaceId: this.workspaceId, jid: stripDeviceSuffix(chat.id) },
            { $set: setFields }
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

  /** Baileys-shaped send — every existing caller (campaigns, message routes,
   *  send-message.service) still speaks `AnyMessageContent` directly. Kept
   *  separate from the channel-neutral `sendMessage()` below rather than
   *  migrated: several of these payloads (message delete, uploaded-buffer
   *  media) have no equivalent in the neutral IR and are Baileys-only concepts. */
  async sendRaw(jid: string, content: AnyMessageContent, options?: unknown): Promise<WAMessage | undefined> {
    if (!this.sock) throw new Error('Instance not connected');
    return this.sock.sendMessage(jid, content, options as Parameters<WASocket['sendMessage']>[2]);
  }

  /** IChannelSession's neutral entrypoint — translates the channel-neutral IR
   *  (see messaging/outbound-types.ts) to Baileys' wire format and sends it. */
  async sendMessage(jid: string, msg: OutboundMessage, options?: unknown): Promise<{ providerMessageId?: string; raw?: unknown }> {
    const content = toBaileys(msg);
    if (!content) return {};
    const sent = await this.sendRaw(jid, content, options);
    return { providerMessageId: sent?.key?.id ?? undefined, raw: sent };
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
    // `$set: { authCreds: undefined, ... }` is silently dropped by the Mongo driver
    // — it does NOT clear the field. The WhatsApp session credentials were NEVER
    // actually deleted on logout: they stayed in the document (retention of
    // material the user explicitly asked to invalidate), and re-pairing loaded
    // those now-invalid creds back in, immediately closing the fresh socket with
    // another 'loggedOut' — the instance was stuck needing a delete+recreate to
    // recover. Needs an actual $unset.
    await Instance.findByIdAndUpdate(this.instanceId, {
      $set: { status: 'disconnected' },
      $unset: { authCreds: 1, authKeys: 1, qrCode: 1 },
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
    const contentWithMedia: Record<string, unknown> = {
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

    // For group messages: extract sender JID from msg.key.participant (who sent this message)
    const senderJid = isGroup && !msg.key.fromMe ? msg.key.participant : undefined;
    const senderPhoneFromJid = senderJid ? parseJid(senderJid) : undefined;

    const sock = this.sock;
    await ingestInboundMessage(
      {
        workspaceId: this.workspaceId,
        instanceId: this.instanceId,
        jid,
        messageId,
        fromMe: msg.key.fromMe ?? false,
        isGroup,
        phone,
        type,
        text: text ?? '',
        content: contentWithMedia,
        quoted: quotedContext,
        senderName,
        contactDisplayName: !msg.key.fromMe ? msg.pushName : undefined,
        conversationName,
        senderJid,
        senderPhone: senderPhoneFromJid,
        timestamp: new Date((msg.messageTimestamp as number) * 1000),
        rawPayload: msg as unknown as Record<string, unknown>,
        providerMessage: msg,
      },
      {
        wsGateway: this.wsGateway,
        sendMessage: this.makeFlowSend(),
        sendPresence: sock ? async (j, state) => { await sock.sendPresenceUpdate(state, j); } : undefined,
        // Engine's .d.ts types profilePictureUrl as (jid) only, but Baileys accepts
        // (jid, 'image' | 'preview') at runtime — 'image' returns the full-res photo.
        fetchAvatar: sock
          ? (j) => (sock.profilePictureUrl as (jid: string, type?: 'image' | 'preview') => Promise<string>)(j, 'image')
          : undefined,
        archiveMedia: sock ? async (savedMessageId) => {
          const { downloadMediaMessage } = await import('@webwhatsapp/engine');
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mimeType = String(contentWithMedia.mimeType || 'application/octet-stream');
          const fileName = typeof contentWithMedia.fileName === 'string' ? contentWithMedia.fileName : undefined;
          await archiveMessageMedia(savedMessageId, this.workspaceId, Buffer.from(buffer), mimeType, fileName);
        } : undefined,
      }
    );
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
      /** scheduled trigger only — see FlowRunner.start(). */
      _scheduledEventSourceAt?: Date;
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
      _scheduledEventSourceAt: params._scheduledEventSourceAt,
    });
  }

  /** Resume a run parked in status='delayed' — called by flow-run-scheduler.ts. */
  async continueDelayedFlowRun(runId: string): Promise<void> {
    if (!this.sock) return;
    const sock = this.sock;
    const { FlowRunner } = await import('../flow-executor');
    const runner = new FlowRunner({
      sendMessage: this.makeFlowSend(),
      sendPresence: async (j, state) => { await sock.sendPresenceUpdate(state, j); },
      wsGateway: this.wsGateway,
    });
    await runner.continueDelayed(runId);
  }

  /** Fire an overdue wait_response timeout — called by flow-run-scheduler.ts. */
  async continueTimedOutFlowRun(runId: string): Promise<void> {
    if (!this.sock) return;
    const sock = this.sock;
    const { FlowRunner } = await import('../flow-executor');
    const runner = new FlowRunner({
      sendMessage: this.makeFlowSend(),
      sendPresence: async (j, state) => { await sock.sendPresenceUpdate(state, j); },
      wsGateway: this.wsGateway,
    });
    await runner.continueTimedOut(runId);
  }
}
