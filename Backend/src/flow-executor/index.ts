import { Types } from 'mongoose';
import { Flow, FlowRun, Conversation } from '../db/models';
import type { AnyMessageContent, WAMessage } from '@webwhatsapp/engine';
import { FlowRunner, type RunnerDeps } from './runner';
import type { FlowContext } from './senders';
import type { WebSocketGateway } from '../ws/gateway';

export { FlowRunner } from './runner';

/**
 * End any non-terminal flow run for a conversation. Called when an attendance is
 * finished (resolved/closed/deleted) so a lingering `waiting`/`running` run can't
 * block a fresh trigger when the contact interacts again — the client always gets
 * re-engaged instead of hitting a dead, orphaned flow step.
 */
export async function cancelFlowRuns(conversationId: string): Promise<number> {
  const res = await FlowRun.updateMany(
    { conversationId, status: { $in: ['running', 'waiting'] } },
    { $set: { status: 'cancelled' } }
  );
  return res.modifiedCount ?? 0;
}

/** Pull the selected option id from an inbound interactive reply, if any. */
export function extractReplyId(msg: WAMessage): string | undefined {
  const m = msg.message;
  if (!m) return undefined;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId;
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  const paramsJson = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (paramsJson) {
    try { const p = JSON.parse(paramsJson); return p.id ?? p.selectedId ?? undefined; } catch { /* ignore */ }
  }
  return undefined;
}

interface InboundParams {
  workspaceId: string;
  instanceId: string;
  conversation: { _id: unknown; contactId?: unknown; name?: string; phone?: string; jid: string };
  contact: FlowContext['contact'];
  text: string;
  msg: WAMessage;
  isGroup?: boolean;
  sendMessage: RunnerDeps['sendMessage'];
  sendPresence?: RunnerDeps['sendPresence'];
  wsGateway?: WebSocketGateway;
}

/**
 * Entry point called for every inbound 1:1 message. Resumes a waiting flow run, or
 * starts a flow whose keyword trigger matches. Never throws into the caller.
 */
export async function handleInboundForFlows(params: InboundParams): Promise<void> {
  const { workspaceId, instanceId, conversation, contact, text, msg, isGroup = false, sendMessage, sendPresence, wsGateway } = params;
  const runner = new FlowRunner({ sendMessage, sendPresence, wsGateway });
  const convId = String(conversation._id);
  const inboundKey = msg.key?.id
    ? { id: msg.key.id, remoteJid: conversation.jid, fromMe: false }
    : undefined;

  // 1) Try to resume a run waiting on this conversation.
  const waitingRun = await FlowRun.findOne({ conversationId: convId, status: 'waiting' }).sort({ updatedAt: -1 });
  if (waitingRun) {
    // Check if a wait_response timeout has elapsed — if so, fire the timeout path
    // instead of resuming. This is a safety net for runs whose in-process setTimeout
    // didn't survive a server restart.
    if (waitingRun.waiting?.waitingUntil && new Date() > waitingRun.waiting.waitingUntil) {
      await runner.handleTimeout(waitingRun, contact, inboundKey);
      // After timeout, re-fetch: if the timeout path led to another waiting step,
      // try to resume it with the current inbound message.
      const refreshed = await FlowRun.findById(waitingRun._id);
      if (refreshed?.status === 'waiting') {
        const progressed = await runner.resume(refreshed, { id: extractReplyId(msg), text, inboundKey });
        if (progressed) return;
      } else {
        // Timeout path completed — fall through to keyword matching so the current
        // message can still trigger a fresh flow.
      }
    } else {
      const progressed = await runner.resume(waitingRun, { id: extractReplyId(msg), text, inboundKey });
      if (progressed) return;
      // Reply didn't match the waiting step (e.g. abandoned flow, or the contact
      // came back later). Fall through: if the text is a fresh trigger keyword we
      // restart below so they're never stuck on a dead step.
    }
  }

  // 2) Don't start a new flow if one is already actively running.
  const active = await FlowRun.exists({ conversationId: convId, status: 'running' });
  if (active) return;

  // 3) Trigger matching. Keyword flows take precedence; an "any_message" catch-all
  //    flow is the fallback so an idle/finished conversation is never left
  //    unanswered. The catch-all does NOT interrupt an active waiting flow — it
  //    only fires when there's no waiting run to preserve.
  //
  //    Groups: by default flows are disabled for groups. A flow can opt-in via
  //    trigger.allowGroups = true; if no enabled flow allows groups, skip entirely.
  if (isGroup) {
    const hasGroupFlow = await Flow.exists({ workspaceId, enabled: true, 'trigger.allowGroups': true });
    if (!hasGroupFlow) return;
  }
  const lower = text.trim().toLowerCase();
  // A flow only runs on its selected instance. Flows with no instance (legacy /
  // "any") still match every instance.
  const anyInstance = [{ instanceId: null }, { instanceId: { $exists: false } }];
  const instanceOr = Types.ObjectId.isValid(instanceId)
    ? [...anyInstance, { instanceId: new Types.ObjectId(instanceId) }]
    : anyInstance;
  const groupFilter = isGroup ? { 'trigger.allowGroups': true } : {};
  const flows = await Flow.find({
    workspaceId, enabled: true,
    'trigger.type': { $in: ['keyword', 'any_message'] },
    $or: instanceOr,
    ...groupFilter,
  }).lean();
  const keywordMatch = lower
    ? flows.find((f) => f.trigger?.type === 'keyword'
        && (f.trigger?.keywords ?? []).some((k) => k && lower.includes(k.toLowerCase())))
    : undefined;

  // Catch-all fallback — only when there's no waiting flow to preserve AND no
  // human agent is assigned (the bot must never talk over an agent handling the
  // conversation). Resolving an attendance clears the assignment, so a finished
  // conversation becomes eligible again.
  let catchAll = (!keywordMatch && !waitingRun)
    ? flows.find((f) => f.trigger?.type === 'any_message')
    : undefined;
  if (catchAll) {
    const conv = await Conversation.findById(convId).select('assignedAgentId').lean();
    if (conv?.assignedAgentId) catchAll = undefined;
  }

  const match = keywordMatch ?? catchAll;
  if (!match) return;

  // A fresh trigger matched — cancel a lingering waiting run so it can't resurface.
  if (waitingRun) {
    await FlowRun.updateOne({ _id: waitingRun._id, status: 'waiting' }, { $set: { status: 'cancelled' } });
  }

  const flowDoc = await Flow.findById(match._id);
  if (!flowDoc) return;
  await runner.start(flowDoc, {
    workspaceId, instanceId, conversationId: convId, jid: conversation.jid,
    contact, triggerMessageId: msg.key?.id ?? undefined, lastText: text, lastInboundKey: inboundKey,
  });
}

export type { AnyMessageContent };
