import pino from 'pino';
import { ScheduledMessage, Conversation } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import type { WebSocketGateway } from '../../ws/gateway';
import { sendTextMessageViaSession } from '../messages/send-message.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 60_000; // "send later" doesn't need second-level precision.
// If a scheduled message is more than this long overdue (e.g. the server was
// down), give up rather than surprise-sending something long stale.
const MAX_OVERDUE_MS = 24 * 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
// Re-entrancy guard — a tick that's still sending when the next one fires would
// otherwise re-fetch the same still-'scheduled' rows and send the same WhatsApp
// message twice (status only flips to 'sent' after the send completes below).
let running = false;

/**
 * Global scheduled-message dispatcher — mirrors campaign-dispatcher.ts's
 * setInterval + persisted-state shape. Ticks every minute, sending any
 * message whose scheduledAt has passed, unless its conversation has since
 * been resolved/closed/archived (also see the proactive cancellation in
 * conversations.routes.ts's PATCH handler).
 */
export function startScheduledMessageDispatcher(sessionManager: SessionManager, gateway: WebSocketGateway): void {
  if (timer) return;
  timer = setInterval(() => { tick(sessionManager, gateway).catch((err) => logger.error({ err }, '[scheduled-messages] tick failed')); }, TICK_MS);
  logger.info('[scheduled-messages] dispatcher started');
}

export function stopScheduledMessageDispatcher(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(sessionManager: SessionManager, gateway: WebSocketGateway): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runTick(sessionManager, gateway);
  } finally {
    running = false;
  }
}

async function runTick(sessionManager: SessionManager, gateway: WebSocketGateway): Promise<void> {
  const now = new Date();
  const due = await ScheduledMessage.find({ status: 'scheduled', scheduledAt: { $lte: now } });

  for (const sched of due) {
    try {
      if (now.getTime() - sched.scheduledAt.getTime() > MAX_OVERDUE_MS) {
        await ScheduledMessage.updateOne({ _id: sched._id }, { $set: { status: 'failed', failureReason: 'Atraso excessivo' } });
        continue;
      }

      const conv = await Conversation.findById(sched.conversationId).select('status assignedAgentId').lean();
      if (!conv || ['resolved', 'closed', 'archived'].includes(conv.status)) {
        await ScheduledMessage.updateOne({ _id: sched._id }, { $set: { status: 'cancelled', failureReason: 'Conversa encerrada/arquivada' } });
        continue;
      }

      const result = await sendTextMessageViaSession({
        workspaceId: sched.workspaceId.toString(),
        conversationId: sched.conversationId.toString(),
        text: sched.content.text,
        agentId: sched.agentId?.toString(),
        quotedMessageId: sched.quotedMessageId,
        sessionManager,
      });

      if (!result.ok) {
        // Instance not ready / reconnecting — try again next tick instead of failing outright.
        if (result.status === 503) continue;
        await ScheduledMessage.updateOne({ _id: sched._id }, { $set: { status: 'failed', failureReason: result.error } });
        continue;
      }

      await ScheduledMessage.updateOne({ _id: sched._id }, { $set: { status: 'sent' } });

      // Payload shape must match the frontend's Message contract (WS handler
      // reads message.timestamp, not createdAt) — mirrors BaileysSession's own
      // 'message:new' broadcast for inbound messages.
      const msg = result.message;
      gateway.broadcastToConversationVisibility(sched.workspaceId.toString(), conv.assignedAgentId?.toString(), 'message:new', {
        conversationId: sched.conversationId.toString(),
        message: {
          id: msg._id.toString(),
          conversationId: sched.conversationId.toString(),
          type: msg.type,
          content: msg.content,
          direction: msg.direction,
          status: msg.status,
          timestamp: msg.createdAt.toISOString(),
          senderName: msg.senderName,
          senderJid: msg.senderJid,
          senderPhone: msg.senderPhone,
          quoted: msg.quoted,
        },
      });
    } catch (err) {
      logger.warn({ err, scheduledMessageId: sched._id }, '[scheduled-messages] failed to send');
    }
  }
}
