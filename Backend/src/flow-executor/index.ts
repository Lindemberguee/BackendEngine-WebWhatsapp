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
    { conversationId, status: { $in: ['running', 'waiting', 'delayed'] } },
    { $set: { status: 'cancelled' } }
  );
  return res.modifiedCount ?? 0;
}

/**
 * End every non-terminal run of a specific flow. Called when a flow is deleted or
 * disabled — previously neither touched in-progress FlowRuns, so a run mid-delay
 * or waiting on a reply for a flow that no longer exists (or was just turned off
 * because it was misbehaving) kept going: DELETE made every subsequent step throw
 * "flow not found" into the run's try/catch (now marks it failed instead of
 * looping forever, but still — better to end it outright here).
 */
export async function cancelFlowRunsForFlow(flowId: string): Promise<number> {
  const res = await FlowRun.updateMany(
    { flowId, status: { $in: ['running', 'waiting', 'delayed'] } },
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
  conversation: { _id: unknown; contactId?: unknown; name?: string; phone?: string; jid: string; allowBotInGroups?: boolean };
  contact: FlowContext['contact'];
  text: string;
  msg: WAMessage;
  isGroup?: boolean;
  /** True when this inbound message's Contact doc was just created (first-ever
   *  contact from this phone number in the workspace) — feeds the 'new_contact'
   *  trigger type. */
  isNewContact?: boolean;
  sendMessage: RunnerDeps['sendMessage'];
  sendPresence?: RunnerDeps['sendPresence'];
  wsGateway?: WebSocketGateway;
}

/**
 * Entry point called for every inbound 1:1 message. Resumes a waiting flow run, or
 * starts a flow whose keyword trigger matches. Never throws into the caller.
 */
export async function handleInboundForFlows(params: InboundParams): Promise<void> {
  const { workspaceId, instanceId, conversation, contact, text, msg, isGroup = false, isNewContact = false, sendMessage, sendPresence, wsGateway } = params;
  const runner = new FlowRunner({ sendMessage, sendPresence, wsGateway });
  const convId = String(conversation._id);
  const inboundKey = msg.key?.id
    ? { id: msg.key.id, remoteJid: conversation.jid, fromMe: false }
    : undefined;

  // The bot must never talk over a human — previously this check only guarded the
  // any_message catch-all (below), so a waiting flow's resume() and a keyword
  // trigger could both still fire and respond right on top of an agent already
  // handling the conversation (assigned, or attendanceMode explicitly set to
  // 'human'). Fetched once up front and reused for both gates below.
  const convState = await Conversation.findById(convId).select('assignedAgentId attendanceMode').lean();
  const humanEngaged = Boolean(convState?.assignedAgentId) || convState?.attendanceMode === 'human';
  if (humanEngaged) return;

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
    const hasGroupFlow = conversation.allowBotInGroups
      || await Flow.exists({ workspaceId, enabled: true, 'trigger.allowGroups': true });
    if (!hasGroupFlow) return;
  }
  const lower = text.trim().toLowerCase();
  // A flow only runs on its selected instance. Flows with no instance (legacy /
  // "any") still match every instance.
  const anyInstance = [{ instanceId: null }, { instanceId: { $exists: false } }];
  const instanceOr = Types.ObjectId.isValid(instanceId)
    ? [...anyInstance, { instanceId: new Types.ObjectId(instanceId) }]
    : anyInstance;
  // Once a group has explicitly opted in (allowBotInGroups), any matching flow may run
  // there regardless of its own trigger.allowGroups — the per-group toggle is the
  // override; otherwise a group still needs a flow that opted in workspace-wide.
  const groupFilter = isGroup && !conversation.allowBotInGroups ? { 'trigger.allowGroups': true } : {};
  const flows = await Flow.find({
    workspaceId, enabled: true,
    'trigger.type': { $in: ['keyword', 'any_message', 'new_contact'] },
    $or: instanceOr,
    ...groupFilter,
  }).lean();
  const keywordMatch = lower
    ? flows.find((f) => f.trigger?.type === 'keyword'
        && (f.trigger?.keywords ?? []).some((k) => k && lower.includes(k.toLowerCase())))
    : undefined;

  // 'new_contact' sits between keyword (most specific) and the any_message
  // catch-all (least specific) — a keyword coincidentally matching someone's
  // very first message still wins, but a first-time contact with no keyword
  // match gets the dedicated welcome flow instead of falling all the way to
  // the generic catch-all.
  const newContactMatch = (!keywordMatch && isNewContact && !waitingRun)
    ? flows.find((f) => f.trigger?.type === 'new_contact')
    : undefined;

  // Catch-all fallback — only when there's no waiting flow to preserve. (The
  // human-engaged check that used to live here is now the single early-return
  // gate above, covering keyword triggers and resume too, not just this catch-all.)
  const catchAll = (!keywordMatch && !newContactMatch && !waitingRun)
    ? flows.find((f) => f.trigger?.type === 'any_message')
    : undefined;

  const match = keywordMatch ?? newContactMatch ?? catchAll;
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
