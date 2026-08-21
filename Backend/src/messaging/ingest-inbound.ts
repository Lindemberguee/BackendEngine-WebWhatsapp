import pino from 'pino';
import { Types } from 'mongoose';
import { Conversation, Message, Contact, type MessageType } from '../db/models';
import type { WebSocketGateway } from '../ws/gateway';
import { lastMessagePreview } from '../utils/message.utils';
import { handleInboundForFlows } from '../flow-executor';
import type { RunnerDeps } from '../flow-executor/runner';
import { maybeAutoCreateLeadFromConversation } from '../modules/crm/crm.service';
import { notify } from '../modules/notifications/notification.service';
import { handleCampaignReply } from '../modules/campaigns/campaign.service';
import { getAutoRouteMode, routeConversation } from '../modules/routing/routing.service';
import { applySlaTimers } from '../modules/routing/sla.service';
import { emitWebhookEvent } from '../modules/webhooks/webhook.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const OPT_OUT_KEYWORDS = new Set(['parar', 'sair', 'stop', 'cancelar', 'unsubscribe']);

/**
 * Everything a channel session (Baileys today, Cloud API later) must normalize
 * BEFORE calling ingestInboundMessage() — provider-specific parsing (JID/phone
 * shape, content-type extraction, media metadata, quoted-message lookup, contact
 * display-name trust rules) stays in the channel. Everything from here down
 * (conversation upsert, routing, SLA, opt-out, campaign reply, notifications,
 * contact bookkeeping, persistence, WS broadcast, flow dispatch) is identical
 * regardless of which network the message arrived on.
 */
export interface NormalizedInbound {
  workspaceId: string;
  instanceId: string;
  jid: string;
  messageId: string;
  fromMe: boolean;
  isGroup: boolean;
  phone: string;
  type: MessageType;
  text: string;
  /** Already merged with type-specific media metadata (duration/dimensions/thumbnail/...). */
  content: Record<string, unknown>;
  quoted?: { messageId: string; type: string; preview: string; senderName?: string; timestamp: Date };
  /** Message-level "who sent this" (Baileys: pushName ?? phone). Used for group
   *  attribution and notification previews — NOT trusted as the contact's real
   *  name on outbound messages (see contactDisplayName). */
  senderName: string;
  /** Only trust as the contact's display name when the message is inbound —
   *  an outbound message's sender identity is the agent/bot, not the contact. */
  contactDisplayName?: string;
  conversationName: string;
  senderJid?: string;
  senderPhone?: string;
  timestamp: Date;
  rawPayload: Record<string, unknown>;
  /** The provider's own message object, passed through untouched to
   *  handleInboundForFlows for reply-id extraction. */
  providerMessage: unknown;
}

export interface IngestDeps {
  wsGateway: WebSocketGateway;
  sendMessage: RunnerDeps['sendMessage'];
  sendPresence?: RunnerDeps['sendPresence'];
  /** Fire-and-forget best-effort avatar fetch — omit if the channel can't do it. */
  fetchAvatar?: (jid: string) => Promise<string | undefined>;
  archiveMedia?: (savedMessageId: string) => Promise<void>;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export async function ingestInboundMessage(p: NormalizedInbound, deps: IngestDeps): Promise<void> {
  const { workspaceId, instanceId, jid, messageId, fromMe, isGroup, phone, type, text, content, quoted, senderName, conversationName, timestamp } = p;

  // Upsert conversation — use workspaceId+jid as the primary key so that manually-created
  // conversations (which have no instanceId) are found and updated rather than triggering
  // a duplicate-key error from the { workspaceId, jid } sparse unique index.
  const conversation = await Conversation.findOneAndUpdate(
    { workspaceId, instanceId, jid },
    {
      $setOnInsert: { workspaceId, jid, isGroup, phone },
      $set: {
        instanceId,
        name: conversationName,
        lastMessage: {
          content: lastMessagePreview(type, text), type,
          direction: fromMe ? 'outbound' : 'inbound',
          timestamp,
          // Group preview shows "João: texto" — irrelevant (and omitted) for 1:1 chats.
          ...(isGroup ? { senderName: fromMe ? 'Você' : senderName } : {}),
        },
        // Reopening (an inbound message on a resolved/closed/snoozed conversation) must
        // clear the previous cycle's resolution/SLA state — otherwise a returning
        // contact's brand-new ticket starts out already flagged "SLA breached" and
        // still carrying the old close reason, both stale from the last time this
        // conversation was closed. Harmless no-op when the conversation was already open.
        ...(fromMe ? {} : {
          status: 'open',
          slaFirstResponseBreached: false,
          slaResolutionBreached: false,
          lastInboundAt: timestamp,
        }),
      },
      // $set with `undefined` is silently dropped by the Mongo driver (it wouldn't
      // clear anything) — these need an actual $unset.
      ...(fromMe ? {} : { $unset: { resolvedAt: 1, closeReasonId: 1, snoozedUntil: 1 } }),
      $inc: { unreadCount: fromMe ? 0 : 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // A fresh upsert has createdAt === updatedAt to the millisecond; used below to
  // gate one-time actions (e.g. CRM auto-lead-creation) to brand-new conversations only.
  const isNewConversation = conversation.createdAt.getTime() === conversation.updatedAt.getTime();

  // Opt-in auto-routing: workspaces that want every new inbound conversation routed
  // immediately (rather than waiting for a bot handoff to a human) set autoRoute='on_new'.
  if (isNewConversation && !isGroup && !fromMe) {
    getAutoRouteMode(workspaceId).then((mode) => {
      if (mode === 'on_new') void routeConversation(conversation._id.toString(), deps.wsGateway);
    }).catch(() => {});
  }

  // Every inbound customer message opens/reopens the ticket — start the SLA
  // clock if the queue/workspace has one configured and none is already running.
  if (!isGroup && !fromMe) {
    void applySlaTimers(conversation._id.toString(), workspaceId, conversation.teamGroupId?.toString());
    void emitWebhookEvent(workspaceId, 'message.received', {
      conversationId: conversation._id.toString(), phone, text, type,
    });
  }

  // Campaign opt-out keyword — a plain-text reply of just "PARAR"/"SAIR"/"STOP"/"CANCELAR"
  // excludes the contact from every future campaign audience. Doesn't affect normal
  // 1:1 support messaging, only bulk/campaign sends (see resolveAudience()).
  if (!isGroup && !fromMe && OPT_OUT_KEYWORDS.has(text.trim().toLowerCase())) {
    Contact.updateOne({ workspaceId, jid }, { $set: { optedOutAt: new Date() } }).catch(() => {});
  }

  // Campaign reply tracking — if this contact received a campaign message recently and
  // hasn't replied yet, mark it and auto-create a CRM lead (see handleCampaignReply).
  if (!isGroup && !fromMe && conversation.contactId) {
    handleCampaignReply(workspaceId, jid, conversation._id.toString(), conversation.contactId.toString()).catch(() => {});
  }

  // Notify the assigned agent, but only on the message that makes the conversation go
  // from "caught up" to "has something new" (unreadCount just became 1) — not on every
  // message of an already-unread conversation, which would spam a notification per message.
  if (!isGroup && !fromMe && conversation.assignedAgentId && conversation.unreadCount === 1) {
    notify(deps.wsGateway, {
      workspaceId, recipientId: conversation.assignedAgentId.toString(),
      type: 'conversation.message', title: 'Nova mensagem recebida',
      message: `${conversationName}: ${lastMessagePreview(type, text)}`,
      link: '/conversations', metadata: { conversationId: conversation._id.toString() },
    }).catch(() => {});
  }

  // Upsert contact (1:1 only — groups aren't contacts). Tracks whether the upsert
  // below just inserted a brand-new Contact — feeds the 'new_contact' flow trigger.
  let isNewContact = false;
  if (!isGroup) {
    const contactName = fromMe ? phone : (p.contactDisplayName ?? phone);
    const contactUpdates: Record<string, unknown> = {
      $setOnInsert: { workspaceId, jid, phone, name: contactName },
    };
    if (!fromMe) {
      contactUpdates.$set = {
        lastSeenAt: timestamp,
        ...(p.contactDisplayName ? { pushName: p.contactDisplayName } : {}),
      };
    }

    const savedContact = await Contact.findOneAndUpdate(
      { workspaceId, jid },
      contactUpdates,
      { upsert: true, new: true }
    );
    isNewContact = savedContact.createdAt.getTime() === savedContact.updatedAt.getTime();

    // Link the contact to this conversation if not already linked
    if (savedContact && conversation && !conversation.contactId) {
      await Conversation.updateOne(
        { _id: conversation._id, contactId: { $exists: false } },
        { $set: { contactId: savedContact._id } }
      );
    }

    // CRM: auto-create a lead for brand-new inbound conversations, if a pipeline opted in.
    if (isNewConversation && !fromMe && savedContact) {
      maybeAutoCreateLeadFromConversation(workspaceId, conversation._id, savedContact._id, savedContact.name)
        .catch((err) => logger.warn({ err }, '[crm] auto-create lead failed'));
    }

    // Proactively fetch profile picture for new contacts (fire-and-forget).
    if (deps.fetchAvatar && savedContact && !savedContact.avatarUrl) {
      const contactId = savedContact._id;
      deps.fetchAvatar(jid)
        .then(async (picUrl) => {
          if (!picUrl) return;
          await Contact.updateOne({ _id: contactId }, { $set: { avatarUrl: picUrl } });
          const updatedConvs = await Conversation.find({ workspaceId, jid });
          await Conversation.updateMany({ workspaceId, jid }, { $set: { avatarUrl: picUrl } });
          for (const conv of updatedConvs) {
            deps.wsGateway.broadcastToWorkspace(workspaceId, 'conversation:updated', {
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
  const msgObjectId = new Types.ObjectId();
  const contentWithMedia = { ...content };
  if (MEDIA_TYPES.has(type)) {
    contentWithMedia.url = `/api/conversations/${conversation._id}/messages/${msgObjectId}/media`;
  }

  // Save message. Guard against the rare race where two concurrent deliveries
  // both clear the exists() check upstream — the unique index rejects the second,
  // which we swallow instead of crashing.
  let savedMsg;
  try {
    savedMsg = await Message.create({
      _id: msgObjectId,
      workspaceId,
      instanceId,
      conversationId: conversation._id,
      jid,
      messageId,
      direction: fromMe ? 'outbound' : 'inbound',
      type,
      status: fromMe ? 'sent' : 'delivered',
      fromMe,
      content: contentWithMedia,
      quoted,
      // Attribute the sender for inbound group messages so the UI can show who spoke.
      senderName: isGroup && !fromMe ? senderName : undefined,
      senderJid: p.senderJid,
      senderPhone: p.senderPhone,
      rawPayload: p.rawPayload,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // duplicate — already stored
    throw err;
  }

  // Broadcast to frontend via WS — shape must match the frontend Message contract
  // (the REST adapter maps createdAt → timestamp; we mirror that here).
  deps.wsGateway.broadcastToConversationVisibility(workspaceId, conversation.assignedAgentId?.toString(), 'message:new', {
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
      quoted: savedMsg.quoted,
    },
  });

  if (MEDIA_TYPES.has(type) && deps.archiveMedia) {
    void deps.archiveMedia(savedMsg._id.toString()).catch((err) => logger.warn({ err, messageId: savedMsg._id }, '[media] automatic archive failed'));
  }

  // ── Flow automation: trigger flows on inbound messages (1:1 and groups) ──
  // Group flows are disabled by default; a flow can opt-in via trigger.allowGroups.
  if (!fromMe) {
    handleInboundForFlows({
      workspaceId,
      instanceId,
      isGroup,
      isNewContact,
      conversation: { _id: conversation._id, contactId: conversation.contactId, name: conversation.name, phone: conversation.phone, jid, allowBotInGroups: conversation.allowBotInGroups },
      contact: { name: conversation.name, phone: conversation.phone },
      text: text ?? '',
      msg: p.providerMessage as never,
      sendMessage: deps.sendMessage,
      sendPresence: deps.sendPresence,
      wsGateway: deps.wsGateway,
    }).catch((err) => logger.warn({ err }, '[flow] inbound handler failed'));
  }
}
