import pino from 'pino';
import { Flow, FlowRun, Conversation, Contact } from '../db/models';
import type { SessionManager } from '../session-manager/SessionManager';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const BATCH_PER_FLOW = 50;
const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 30 * 24 * 60; // 30 days

/**
 * Dispatches every enabled 'scheduled' flow — the trigger fires a fixed delay
 * after a per-conversation event (conversation created, no reply from the
 * contact, conversation closed), not off an inbound WhatsApp message. Called
 * from flow-run-scheduler.ts's existing 15s tick rather than its own timer.
 *
 * Idempotency: each event has an "anchor" timestamp (createdAt / lastMessage
 * .timestamp / resolvedAt). A run is only started once per distinct anchor
 * value for a given (flow, conversation) pair — see FlowRun.scheduledEventSourceAt.
 * If the anchor moves (a new message arrives, the conversation reopens/closes
 * again) it's a new episode and can fire again.
 */
export async function dispatchScheduledEventFlows(sessionManager: SessionManager, now: Date): Promise<void> {
  const flows = await Flow.find({ enabled: true, 'trigger.type': 'scheduled' }).lean();
  for (const flow of flows) {
    try {
      await dispatchForFlow(sessionManager, flow, now);
    } catch (err) {
      logger.warn({ err, flowId: flow._id }, '[flow] scheduled-event dispatch failed for flow');
    }
  }
}

async function dispatchForFlow(sessionManager: SessionManager, flow: Record<string, any>, now: Date): Promise<void> {
  const trigger = flow.trigger as { scheduledEvent?: string; scheduledDelayMinutes?: number };
  const event = trigger?.scheduledEvent;
  if (!event) return;
  const delayMinutes = Math.min(MAX_DELAY_MINUTES, Math.max(MIN_DELAY_MINUTES, trigger.scheduledDelayMinutes ?? 60));
  const cutoff = new Date(now.getTime() - delayMinutes * 60_000);

  const baseQuery: Record<string, unknown> = { workspaceId: flow.workspaceId };
  if (flow.instanceId) baseQuery.instanceId = flow.instanceId;

  let query: Record<string, unknown>;
  let anchorOf: (conv: Record<string, any>) => Date | undefined;
  if (event === 'conversation_created') {
    query = { ...baseQuery, createdAt: { $lte: cutoff }, status: { $nin: ['resolved', 'closed'] } };
    anchorOf = (conv) => conv.createdAt;
  } else if (event === 'no_reply') {
    query = {
      ...baseQuery,
      status: { $in: ['open', 'pending'] },
      'lastMessage.direction': 'outbound',
      'lastMessage.timestamp': { $lte: cutoff },
    };
    anchorOf = (conv) => conv.lastMessage?.timestamp;
  } else if (event === 'conversation_closed') {
    query = { ...baseQuery, status: { $in: ['resolved', 'closed'] }, resolvedAt: { $lte: cutoff } };
    anchorOf = (conv) => conv.resolvedAt;
  } else {
    return;
  }

  const conversations = await Conversation.find(query)
    .select('workspaceId instanceId jid name phone contactId status assignedAgentId attendanceMode createdAt resolvedAt lastMessage isGroup')
    .limit(BATCH_PER_FLOW)
    .lean();

  for (const conv of conversations) {
    // Bot never talks over a human — same gate as the inbound-message path.
    if (conv.assignedAgentId || conv.attendanceMode === 'human') continue;
    if (conv.isGroup) continue;
    if (!conv.instanceId) continue;

    const anchorAt = anchorOf(conv);
    if (!anchorAt) continue;

    const alreadyFired = await FlowRun.exists({
      flowId: flow._id, conversationId: conv._id, scheduledEventSourceAt: anchorAt,
    });
    if (alreadyFired) continue;

    const activeRun = await FlowRun.exists({
      conversationId: conv._id, status: { $in: ['running', 'waiting', 'delayed'] },
    });
    if (activeRun) continue;

    const session = sessionManager.getSession(String(conv.instanceId));
    if (!session) continue;

    const flowDoc = await Flow.findById(flow._id);
    if (!flowDoc) continue;

    const contact = conv.contactId ? await Contact.findById(conv.contactId).lean() : null;
    try {
      await session.triggerFlow(flowDoc, {
        conversationId: String(conv._id),
        jid: conv.jid,
        contact: { name: contact?.name ?? conv.name, phone: contact?.phone ?? conv.phone },
        _scheduledEventSourceAt: anchorAt,
      });
    } catch (err) {
      logger.warn({ err, flowId: flow._id, conversationId: conv._id }, '[flow] scheduled-event trigger failed for conversation');
    }
  }
}
