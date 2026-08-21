import { Types } from 'mongoose';
import type { WAMessage } from '@webwhatsapp/engine';
import { Conversation, Instance, Message, type IMessage } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import { lastMessagePreview, extractPreview } from '../../utils/message.utils';
import { markFirstResponse } from '../routing/sla.service';

export interface SendTextMessageParams {
  workspaceId: string;
  conversationId: string;
  text: string;
  agentId?: string;
  quotedMessageId?: string;
  sessionManager: SessionManager;
}

export type SendTextMessageResult =
  | { ok: true; message: IMessage }
  | { ok: false; status: number; error: string };

/**
 * Picks which WhatsApp instance to (re)attach a conversation to when it has none
 * stored — used by every outbound-send path as a fallback. `Instance.findOne` with
 * no sort is non-deterministic (whichever the DB happens to return first), so a
 * workspace with multiple numbers could silently send a customer's reply from the
 * wrong number — and since the caller persists that choice as the conversation's
 * instanceId, it would keep doing it forever. Deterministic preference: connected
 * first, then connecting, then error (never give up on a mid-reconnect instance);
 * ties broken by whichever was connected most recently.
 */
export async function resolveFallbackInstance(workspaceId: string) {
  for (const status of ['connected', 'connecting', 'error'] as const) {
    const inst = await Instance.findOne({ workspaceId, status }).sort({ lastConnectedAt: -1 });
    if (inst) return inst;
  }
  return null;
}

/**
 * Text-message send path, extracted out of messages.routes.ts's POST
 * /:conversationId/messages so it can be reused by the scheduled-message
 * dispatcher (see scheduled-messages/scheduled-message-scheduler.ts). Only
 * covers `text` — image/video/audio/document sends stay inline in the route
 * (scheduling is text-only in v1).
 */
export async function sendTextMessageViaSession(params: SendTextMessageParams): Promise<SendTextMessageResult> {
  const { workspaceId, conversationId, text, agentId, quotedMessageId, sessionManager } = params;

  const conv = await Conversation.findOne({ _id: conversationId, workspaceId });
  if (!conv) return { ok: false, status: 404, error: 'Conversa não encontrada' };

  // Resolve the instance to send through. Older conversations may have no
  // instanceId stored, so fall back to any connectable instance and backfill it.
  let resolvedInstanceId = conv.instanceId;
  if (!resolvedInstanceId) {
    const inst = await resolveFallbackInstance(workspaceId);
    if (!inst) return { ok: false, status: 503, error: 'Nenhuma instância WhatsApp configurada' };
    resolvedInstanceId = inst._id;
    await Conversation.updateOne({ _id: conversationId }, { $set: { instanceId: inst._id } });
  }

  // Lazily (re)establish the session if it isn't in memory, then wait for the
  // WhatsApp connection to be open.
  const session = await sessionManager.ensureSession(resolvedInstanceId.toString());
  const ready = await session.waitUntilReady(8000);
  if (!ready) return { ok: false, status: 503, error: 'WhatsApp reconectando. Tente novamente em alguns segundos.' };

  const options: Record<string, unknown> = {};
  // quotedMessageId is our Mongo _id (see chat.api.ts toMessage()), not WhatsApp's own key.id.
  let quotedContext: Record<string, unknown> | undefined;
  if (quotedMessageId && Types.ObjectId.isValid(quotedMessageId)) {
    const quoted = await Message.findOne({ _id: quotedMessageId, conversationId }).lean();
    if (quoted?.rawPayload) options.quoted = { key: { id: quoted.messageId, remoteJid: conv.jid }, message: quoted.rawPayload };
    if (quoted) {
      quotedContext = {
        messageId: quoted.messageId,
        type: quoted.type,
        preview: extractPreview(quoted as never),
        senderName: quoted.fromMe ? 'Você' : quoted.senderName,
        timestamp: quoted.createdAt,
      };
    }
  }

  // Baileys keeps its own raw-content path (native reply-quote support via
  // rawPayload); any other channel goes through the neutral IChannelSession
  // entrypoint. Cloud API sends still work — they just don't carry the native
  // WhatsApp quote visual (the IR has no "reply to" concept yet), the quoted
  // context is still stored on our own Message doc below either way.
  let providerMessageId: string | undefined;
  if (session.channel === 'baileys') {
    const sent = await session.sendRaw!(conv.jid, { text } as never, options) as WAMessage | undefined;
    providerMessageId = sent?.key?.id;
  } else {
    const sent = await session.sendMessage(conv.jid, { kind: 'text', text }, options);
    providerMessageId = sent.providerMessageId;
  }

  let savedMsg: IMessage;
  try {
    savedMsg = await Message.create({
      workspaceId,
      instanceId: resolvedInstanceId,
      conversationId,
      jid: conv.jid,
      messageId: providerMessageId ?? `temp_${Date.now()}`,
      direction: 'outbound',
      type: 'text',
      status: 'sent',
      fromMe: true,
      content: { text },
      agentId,
      quoted: quotedContext,
    });
  } catch (err) {
    // Baileys' own echo of our outgoing message (processed by BaileysSession's
    // 'messages.upsert' handler, config.emitOwnEvents) can race this insert and win —
    // both write the same messageId, and the unique {workspaceId, messageId} index
    // rejects whichever loses. Rather than surface that as a 500 (the message DID
    // send successfully), return the row the echo already created.
    if ((err as { code?: number }).code === 11000 && providerMessageId) {
      const existing = await Message.findOne({ workspaceId, messageId: providerMessageId });
      if (existing) { savedMsg = existing; } else { throw err; }
    } else {
      throw err;
    }
  }

  await Conversation.updateOne({ _id: conversationId }, {
    lastMessage: { content: lastMessagePreview('text', text), type: 'text', direction: 'outbound', timestamp: new Date() },
  });
  // A human agent (not a flow/bot) just replied — stop the first-response SLA clock.
  void markFirstResponse(conversationId);

  return { ok: true, message: savedMsg };
}
