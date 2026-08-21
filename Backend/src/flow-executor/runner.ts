import { Types } from 'mongoose';
import pino from 'pino';
import { Flow, FlowRun, Conversation, Contact } from '../db/models';
import type { IFlow, IFlowNode, IFlowRun, UserRole } from '../db/models';
import { ensureLabel } from '../modules/labels/labels.service';
import { createLeadFromFlow, moveLeadForContact, assignLeadForContact, updateLeadValueForContact, addLeadNoteForContact, getOpenLeadStageName } from '../modules/crm/crm.service';
import { notify, notifyMany, resolveNotificationTargets, type NotificationTargetType } from '../modules/notifications/notification.service';
import { getAutoRouteMode, routeConversation } from '../modules/routing/routing.service';
import { clearSlaTimers } from '../modules/routing/sla.service';
import { normalizeNodes, normalizeEdges, nodeById, nextNodeId, entryNode } from './graph';
import { buildMessageContent, interpolate, type FlowContext } from './senders';
import { isPublicHttpUrl } from '../shared/url-security';
import type { AnyMessageContent } from '@webwhatsapp/engine';
import type { WebSocketGateway } from '../ws/gateway';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export interface RunnerDeps {
  sendMessage: (jid: string, content: AnyMessageContent) => Promise<{ key?: { id?: string } } | undefined>;
  /** Presence update (typing/recording indicator). Optional — no-op if absent. */
  sendPresence?: (jid: string, state: 'composing' | 'recording' | 'paused') => Promise<void>;
  /** Needed for the notification.send block and attendance-block notifications. Optional — those blocks no-op without it. */
  wsGateway?: WebSocketGateway;
}

const MAX_STEPS_PER_CALL = 50; // guard against tight loops within a single advance() call
// Cumulative budget across a run's whole lifetime (persisted on the FlowRun doc, so
// it survives across delay/waiting resumes, unlike MAX_STEPS_PER_CALL). Without this,
// a cycle in the graph that passes through a delay/typing block resets its step
// count on every continuation and runs — and sends messages to the customer —
// forever. 300 is generous for any legitimate flow (the biggest real ones here are
// a few dozen nodes) while still bounding a runaway loop to a few hundred messages
// instead of infinite.
const MAX_TOTAL_STEPS = 300;
// automation.jump_flow starts a brand-new FlowRun (own stepCount budget), so a cycle
// of jumps (A → B → A → …) isn't caught by MAX_TOTAL_STEPS alone — each hop resets
// it. This caps how many jumps can chain before a run refuses to start.
const MAX_JUMP_DEPTH = 8;

// Guards against the same FlowRun being walked twice concurrently. Without this,
// two near-simultaneous inbound events for one conversation (e.g. a fast double
// message, or a resume() and a start() overlapping) can each read the run before
// either saves, and both independently advance it — every side-effecting block
// they pass through (notably notification.send, but also message sends) fires
// twice. A new FlowRunner is constructed per call site, so this must be
// module-level, not an instance field, to actually cover concurrent callers.
const advancingRuns = new Set<string>();

// Which blocks pause the flow waiting for a user selection, and their port ids.
function waitingPorts(node: IFlowNode): string[] | null {
  const c = node.config;
  switch (node.blockType) {
    case 'message.buttons': return ((c.buttons as { id: string }[]) ?? []).map((b) => b.id);
    case 'message.cta': {
      const replies = ((c.buttons as { id: string; type: string }[]) ?? []).filter((b) => b.type === 'reply');
      return replies.length ? replies.map((b) => b.id) : null;
    }
    case 'message.list': return ((c.sections as { rows: { id: string }[] }[]) ?? []).flatMap((s) => s.rows.map((r) => r.id));
    case 'message.carousel': return ((c.cards as { id: string }[]) ?? []).map((cd) => cd.id);
    default: return null;
  }
}

/** Shared text/number comparator for condition blocks. */
function compare(subject: string, value: string, operator: string): boolean {
  const a = subject.toLowerCase();
  const b = String(value ?? '').toLowerCase();
  switch (operator) {
    case 'equals': return a === b;
    case 'contains': return a.includes(b);
    case 'starts_with': return a.startsWith(b);
    case 'ends_with': return a.endsWith(b);
    case 'is_set': return a.trim().length > 0;
    case 'greater_than': return parseFloat(a.replace(',', '.')) > parseFloat(b.replace(',', '.'));
    case 'less_than': return parseFloat(a.replace(',', '.')) < parseFloat(b.replace(',', '.'));
    default: return false;
  }
}

function evalCondition(node: IFlowNode, ctx: FlowContext): boolean {
  const { field, operator, value } = node.config as { field: string; operator: string; value: string };
  let subject = '';
  if (field === 'message_text') subject = String(ctx.variables._lastText ?? '');
  else if (field === 'contact_name') subject = ctx.contact.name ?? '';
  else if (field === 'contact_tag') subject = String(ctx.variables._tags ?? '');
  else if (field === 'crm_stage') subject = String(ctx.variables._crmStage ?? '');
  return compare(subject, value, operator);
}

/** condition.variable → compare any saved variable against a value. */
function evalVariable(node: IFlowNode, ctx: FlowContext): boolean {
  const { variableName, operator, value } = node.config as { variableName: string; operator: string; value: string };
  const subject = String(ctx.variables[variableName] ?? '');
  return compare(subject, value, operator);
}

/** Brazilian CPF check-digit validation. */
function isValidCPF(raw: string): boolean {
  const cpf = raw.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

/** condition.input_format → validate the last inbound text against a format. */
function evalInputFormat(node: IFlowNode, ctx: FlowContext): boolean {
  const { format, pattern } = node.config as { format: string; pattern?: string };
  const input = String(ctx.variables._lastText ?? '').trim();
  if (!input) return false;
  switch (format) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
    case 'number': return /^-?\d+([.,]\d+)?$/.test(input);
    case 'cpf': return isValidCPF(input);
    case 'phone': { const d = input.replace(/\D/g, ''); return d.length >= 10 && d.length <= 15; }
    case 'url': return /^https?:\/\/.+/i.test(input);
    case 'regex': {
      // A workspace-authored pattern (condition.input_format's regex mode) is run
      // against text controlled by the end customer. A pattern with catastrophic
      // backtracking (e.g. `(a+)+$`) can hang the event loop — for this
      // single-process server that means every workspace's WebSocket, every HTTP
      // route, and every other WhatsApp session, not just this one flow. There's
      // no cheap true ReDoS guard without a worker/timeout mechanism, so bound
      // the blast radius instead: cap both pattern and input length, which is
      // enough to keep worst-case backtracking in the sub-second range for the
      // vast majority of catastrophic patterns.
      const safePattern = (pattern ?? '').slice(0, 200);
      const safeInput = input.slice(0, 500);
      try { return new RegExp(safePattern).test(safeInput); } catch { return false; }
    }
    default: return false;
  }
}

/** Current minutes-of-day in a timezone (0–1439). */
function nowMinutesInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hh * 60 + mm;
}

/** condition.time → true when the current time is within [start, end] (handles overnight). */
function evalTime(node: IFlowNode): boolean {
  const { startTime, endTime, timezone } = node.config as { startTime?: string; endTime?: string; timezone?: string };
  const toMin = (t?: string) => { const [h, m] = String(t ?? '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const cur = nowMinutesInTz(timezone || 'America/Sao_Paulo');
  const start = toMin(startTime || '00:00');
  const end = toMin(endTime || '23:59');
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

/** condition.weekday → true when today (in tz) is one of the allowed days. */
function evalWeekday(node: IFlowNode): boolean {
  const { days, timezone } = node.config as { days?: string[]; timezone?: string };
  const allowed = new Set((days ?? []).map((d) => String(d).toLowerCase()));
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timezone || 'America/Sao_Paulo' }).format(new Date()).toLowerCase();
  return allowed.has(today);
}

export class FlowRunner {
  constructor(private deps: RunnerDeps) {}

  /** Begin a run at the flow's entry node for a conversation. */
  async start(flow: IFlow, params: {
    workspaceId: string; instanceId: string; conversationId: string; jid: string;
    contact: FlowContext['contact']; triggerMessageId?: string; lastText?: string;
    lastInboundKey?: FlowContext['lastInboundKey'];
    /** Variables inherited from a jump_flow — merged before _lastText so the new flow can still use collected vars. */
    _inheritedVariables?: Record<string, unknown>;
    /** How many automation.jump_flow hops preceded this start() — 0 for a directly
     *  triggered run. See MAX_JUMP_DEPTH. */
    _jumpDepth?: number;
    /** scheduled trigger only — the anchor timestamp that fired this run, stored so
     *  the sweep in scheduled-event-trigger.ts can tell it already fired for this
     *  episode. */
    _scheduledEventSourceAt?: Date;
  }): Promise<void> {
    const jumpDepth = params._jumpDepth ?? 0;
    if (jumpDepth > MAX_JUMP_DEPTH) {
      logger.error(
        { workspaceId: params.workspaceId, conversationId: params.conversationId, flowId: flow._id.toString(), jumpDepth },
        '[flow] refusing to start — jump_flow chain exceeded MAX_JUMP_DEPTH (likely a cycle between flows)'
      );
      return;
    }

    const nodes = normalizeNodes(flow);
    const edges = normalizeEdges(flow);
    const entry = entryNode(nodes, edges);
    if (!entry) return;
    // Trigger nodes just start the flow; begin at the node after them.
    const firstId = entry.blockType === 'automation.trigger' ? nextNodeId(edges, entry.id) : entry.id;
    if (!firstId) return;

    const run = await FlowRun.create({
      workspaceId: new Types.ObjectId(params.workspaceId),
      instanceId: new Types.ObjectId(params.instanceId),
      flowId: flow._id,
      conversationId: new Types.ObjectId(params.conversationId),
      jid: params.jid,
      currentNodeId: firstId,
      status: 'running',
      variables: { ...(params._inheritedVariables ?? {}), _lastText: params.lastText ?? '' },
      triggerMessageId: params.triggerMessageId,
      lastInboundMessageId: params.lastInboundKey?.id,
      jumpDepth,
      scheduledEventSourceAt: params._scheduledEventSourceAt,
    });

    await this.advance(run._id.toString(), params.contact, params.lastInboundKey);
  }

  /**
   * Resume a waiting run with an inbound reply (button/list id, or free text).
   * Returns `true` if the run advanced, `false` if the reply didn't match and the
   * run stayed waiting — the caller can then decide to re-trigger a fresh flow.
   */
  async resume(run: IFlowRun, reply: { id?: string; text: string; inboundKey?: FlowContext['lastInboundKey'] }): Promise<boolean> {
    // Atomically claim the run before doing anything else: two near-simultaneous
    // inbound messages from the same contact could both read this same 'waiting'
    // document (index.ts's lookup is a plain findOne, not atomic) and, without
    // this, both would compute the next node and save — executing the branch
    // twice (duplicate message/lead/notification) or racing each other's writes.
    // Only the caller that wins this update actually proceeds; the loser sees
    // `null` and backs off as if the reply hadn't matched.
    const claimed = await FlowRun.findOneAndUpdate(
      { _id: run._id, status: 'waiting' },
      { $set: { status: 'running' } },
      { new: true }
    );
    if (!claimed) return false;
    run = claimed;

    const flow = await Flow.findById(run.flowId);
    if (!flow) { run.status = 'completed'; await run.save(); return false; }
    // A disabled flow shouldn't keep advancing runs already in progress — cancel
    // instead of resuming so the conversation becomes eligible for a fresh trigger.
    if (!flow.enabled) { run.status = 'cancelled'; await run.save(); return false; }
    const edges = normalizeEdges(flow);
    const waiting = run.waiting;
    if (!waiting) { run.status = 'completed'; await run.save(); return false; }

    const nodes = normalizeNodes(flow);
    let port = 'out';
    if (waiting.kind === 'reply') {
      const node = nodeById(nodes, waiting.nodeId);
      const varName = String((node?.config.variableName as string) ?? '');
      if (varName) {
        run.variables = { ...run.variables, [varName]: reply.text };
        if (node?.config.persistToContact) void this.persistVariableToContact(run.conversationId, varName, reply.text);
      }
      // wait_response uses 'resposta' as its success port; save_response uses 'out'.
      if (node?.blockType === 'action.wait_response') port = 'resposta';
    } else if (reply.id && waiting.portIds.includes(reply.id)) {
      port = reply.id;
    } else {
      // Reply didn't match any button/list/CTA option. Previously this just
      // `return false`d with the run already flipped to 'running' by the atomic
      // claim above — never reverted, so the run got permanently stuck (it never
      // actually re-entered 'waiting', silently breaking every subsequent reply
      // for that conversation). Now: revert the claim, and — when the block opted
      // into it — nudge the customer and count attempts toward the 'invalid' port.
      const node = nodeById(nodes, waiting.nodeId);
      const cfg = (node?.config ?? {}) as { retryOnInvalid?: boolean; maxRetries?: number; invalidMessage?: string };
      const attempts = (waiting.invalidAttempts ?? 0) + 1;
      const maxRetries = Math.max(1, Number(cfg.maxRetries) || 2);

      if (cfg.retryOnInvalid && attempts <= maxRetries) {
        run.waiting = { ...waiting, invalidAttempts: attempts };
        run.status = 'waiting';
        await run.save();
        const nudge = String(cfg.invalidMessage ?? '').trim();
        if (nudge) {
          try { await this.deps.sendMessage(run.jid, { text: nudge } as never); } catch { /* ignore */ }
        }
        return false;
      }
      if (cfg.retryOnInvalid) {
        // Retries exhausted — follow the dedicated 'invalid' port (typically to a
        // human handoff or a different message) instead of leaving the customer
        // stuck in front of a bot that keeps re-asking forever.
        const invalidNext = nextNodeId(edges, waiting.nodeId, 'invalid');
        run.waiting = undefined;
        run.currentNodeId = invalidNext;
        run.status = invalidNext ? 'running' : 'completed';
        await run.save();
        if (invalidNext) {
          const contact = await this.loadContact(run);
          await this.advance(run._id.toString(), contact, reply.inboundKey);
        }
        return true;
      }
      // No retry configured for this block — same behavior as before (keep
      // waiting for a matching reply), just with the claim correctly reverted.
      run.status = 'waiting';
      await run.save();
      return false;
    }

    run.variables = { ...run.variables, _lastText: reply.text };
    run.lastInboundMessageId = reply.inboundKey?.id;
    const next = nextNodeId(edges, waiting.nodeId, port);
    run.currentNodeId = next;
    run.waiting = undefined;
    run.status = next ? 'running' : 'completed';
    await run.save();

    if (next) {
      const contact = await this.loadContact(run);
      await this.advance(run._id.toString(), contact, reply.inboundKey);
    }
    return true;
  }

  private async loadContact(run: IFlowRun): Promise<FlowContext['contact']> {
    const conv = await Conversation.findById(run.conversationId).lean();
    const contact = conv?.contactId ? await Contact.findById(conv.contactId).lean() : null;
    return { name: contact?.name ?? conv?.name, phone: conv?.phone, email: contact?.email, company: undefined };
  }

  /** Execute nodes sequentially until the flow waits, delays or ends. Guarded so the
   *  same run can't be walked by two overlapping calls (see `advancingRuns` above). */
  private async advance(runId: string, contact: FlowContext['contact'], lastInboundKey?: FlowContext['lastInboundKey']): Promise<void> {
    if (advancingRuns.has(runId)) {
      logger.warn({ runId }, '[flow] advance() already in progress for this run — skipping duplicate call');
      return;
    }
    advancingRuns.add(runId);
    try {
      await this.advanceLocked(runId, contact, lastInboundKey);
    } finally {
      advancingRuns.delete(runId);
    }
  }

  private async advanceLocked(runId: string, contact: FlowContext['contact'], lastInboundKey?: FlowContext['lastInboundKey']): Promise<void> {
    for (let step = 0; step < MAX_STEPS_PER_CALL; step++) {
      const run = await FlowRun.findById(runId);
      if (!run || run.status !== 'running' || !run.currentNodeId) return;
      const flow = await Flow.findById(run.flowId);
      if (!flow) return;
      if (!flow.enabled) {
        // The flow was disabled/deleted-and-recreated mid-run — don't keep
        // advancing (and messaging the customer) for an automation the operator
        // just turned off.
        run.status = 'cancelled';
        await run.save();
        return;
      }
      // Cumulative step budget — persisted on the run itself, so it survives across
      // delay/waiting resumes (which each start a fresh MAX_STEPS_PER_CALL count).
      // Without this a cycle that loops through automation.delay/typing runs (and
      // messages the customer) forever.
      if (run.stepCount >= MAX_TOTAL_STEPS) {
        logger.error({ runId, flowId: flow._id.toString() }, '[flow] run exceeded MAX_TOTAL_STEPS — stopping (likely a loop in the graph)');
        run.status = 'failed';
        run.failureReason = 'Limite de passos excedido — possível loop no fluxo';
        await run.save();
        return;
      }
      run.stepCount += 1;
      const nodes = normalizeNodes(flow);
      const edges = normalizeEdges(flow);
      const node = nodeById(nodes, run.currentNodeId);
      if (!node) { run.status = 'completed'; await run.save(); return; }

      const triggerKey = run.triggerMessageId ? { id: run.triggerMessageId, remoteJid: run.jid, fromMe: false } : undefined;
      const ctx: FlowContext = { variables: run.variables, contact, lastInboundKey, triggerKey };

      try {

      // ── Send message / payment blocks ──────────────────────────────────────
      if (node.blockType.startsWith('message.') || node.blockType.startsWith('payment.')) {
        const content = await buildMessageContent(node, ctx, run.workspaceId.toString());
        if (content) {
          try { await this.deps.sendMessage(run.jid, content); }
          catch (err) {
            // Media blocks fail here when the URL isn't reachable by the server
            // (page links, blob:, localhost, 403/404). Surface the real reason
            // instead of swallowing it silently.
            const reason = err instanceof Error ? err.message : String(err);
            logger.error({ node: node.id, blockType: node.blockType, reason }, '[flow] send failed — se for mídia, verifique se a URL é um link público direto para o arquivo');
          }
        }
        const ports = waitingPorts(node);
        if (ports && ports.length) {
          run.waiting = { nodeId: node.id, portIds: ports, kind: node.blockType === 'message.list' ? 'list' : 'button' };
          run.status = 'waiting';
          await run.save();
          return;
        }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }

      // ── Condition ──────────────────────────────────────────────────────────
      if (node.blockType.startsWith('condition.')) {
        let result: boolean;
        if (node.blockType === 'condition.time') result = evalTime(node);
        else if (node.blockType === 'condition.weekday') result = evalWeekday(node);
        else if (node.blockType === 'condition.variable') result = evalVariable(node, ctx);
        else if (node.blockType === 'condition.input_format') result = evalInputFormat(node, ctx);
        else {
          // condition.if — tag/stage conditions need live data, not something
          // carried in run.variables.
          const field = (node.config as { field?: string }).field;
          if (field === 'contact_tag') {
            const conv = await Conversation.findById(run.conversationId).lean();
            ctx.variables._tags = (conv?.tags ?? []).join(',');
          } else if (field === 'crm_stage') {
            ctx.variables._crmStage = await getOpenLeadStageName(run.workspaceId, run.conversationId);
          }
          result = evalCondition(node, ctx);
        }
        await this.moveNext(run, edges, node.id, result ? 'true' : 'false');
        continue;
      }

      // ── Actions ────────────────────────────────────────────────────────────
      if (node.blockType === 'action.add_tag' || node.blockType === 'action.remove_tag') {
        const tag = String(node.config.tag ?? '').trim();
        if (tag) await this.applyTag(run, tag, node.blockType === 'action.add_tag');
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'action.set_variable') {
        const varName = String(node.config.variableName ?? '').trim();
        if (varName) {
          const value = interpolate(String(node.config.value ?? ''), ctx);
          run.variables = { ...run.variables, [varName]: value };
          await run.save();
          if (node.config.persistToContact) void this.persistVariableToContact(run.conversationId, varName, value);
        }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'action.block_contact') {
        try {
          const conv = await Conversation.findById(run.conversationId).select('contactId').lean();
          if (conv?.contactId) await Contact.updateOne({ _id: conv.contactId }, { $set: { status: 'blocked', isBlocked: true } });
        } catch (err) { logger.warn({ err, node: node.id }, '[flow] block_contact failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'action.update_name') {
        try {
          const newName = interpolate(String(node.config.name ?? ''), ctx).trim();
          if (newName) {
            const conv = await Conversation.findById(run.conversationId).select('contactId').lean();
            if (conv?.contactId) await Contact.updateOne({ _id: conv.contactId }, { $set: { name: newName } });
            await Conversation.updateOne({ _id: run.conversationId }, { $set: { name: newName } });
            if (contact) contact.name = newName; // keep subsequent {{nome}} interpolation in this run in sync
          }
        } catch (err) { logger.warn({ err, node: node.id }, '[flow] update_name failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'action.update_field') {
        try {
          const field = String(node.config.field ?? '').trim();
          if (field) {
            const value = interpolate(String(node.config.value ?? ''), ctx);
            const conv = await Conversation.findById(run.conversationId).select('contactId').lean();
            if (conv?.contactId) await Contact.updateOne({ _id: conv.contactId }, { $set: { [`customFields.${field}`]: value } });
          }
        } catch (err) { logger.warn({ err, node: node.id }, '[flow] update_field failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'action.save_response') {
        // Send the prompt (the question) before waiting for the reply.
        const prompt = interpolate(String(node.config.prompt ?? ''), ctx).trim();
        if (prompt) {
          try { await this.deps.sendMessage(run.jid, { text: prompt } as never); } catch { /* ignore */ }
        }
        run.waiting = { nodeId: node.id, portIds: [], kind: 'reply' };
        run.status = 'waiting';
        await run.save();
        return;
      }

      // ── Aguardar Resposta ──────────────────────────────────────────────────
      if (node.blockType === 'action.wait_response') {
        const prompt = interpolate(String(node.config.prompt ?? ''), ctx).trim();
        if (prompt) {
          try { await this.deps.sendMessage(run.jid, { text: prompt } as never); } catch { /* ignore */ }
        }
        const hasTimeout = Boolean(node.config.hasTimeout);
        let waitingUntil: Date | undefined;
        if (hasTimeout) {
          const ms = waitResponseTimeoutMs(node.config as { timeoutDuration?: number; timeoutUnit?: string });
          waitingUntil = new Date(Date.now() + ms);
        }
        run.waiting = { nodeId: node.id, portIds: [], kind: 'reply', waitingUntil };
        run.status = 'waiting';
        await run.save();
        // Best-effort in-process timer for the common case (fast feel, no need to
        // wait for the scheduler's next tick). node's setTimeout silently fires
        // *immediately* if the delay exceeds ~24.8 days (2^31-1 ms overflow) — a
        // "remind me in 30 days" timeout used to fire the moment it was set. Clamp
        // the timer itself to a safe window and re-check the real waitingUntil
        // inside the callback before acting; flow-run-scheduler.ts is the actual
        // authoritative sweep for anything longer (and for surviving a restart —
        // this timer doesn't).
        if (waitingUntil) {
          const SAFE_MAX_TIMEOUT_MS = 20 * 86_400_000; // 20 days, safely under the overflow limit
          const target = waitingUntil;
          const delay = Math.max(0, Math.min(target.getTime() - Date.now(), SAFE_MAX_TIMEOUT_MS));
          const runId = run._id.toString();
          const nodeId = node.id;
          setTimeout(async () => {
            try {
              if (new Date() < target) return; // clamped timer fired early — the scheduler will catch it at the real time
              const r = await FlowRun.findById(runId);
              if (r?.status === 'waiting' && r.waiting?.nodeId === nodeId) {
                await this.handleTimeout(r, contact, lastInboundKey);
              }
            } catch { /* ignore */ }
          }, delay);
        }
        return;
      }

      // ── Attendance ─────────────────────────────────────────────────────────
      if (node.blockType === 'attendance.transfer_agent') {
        const agentId = String(node.config.agentId ?? '');
        if (Types.ObjectId.isValid(agentId)) {
          await Conversation.updateOne({ _id: run.conversationId }, { assignedAgentId: new Types.ObjectId(agentId), status: 'open' });
          if (this.deps.wsGateway) {
            void notify(this.deps.wsGateway, {
              workspaceId: run.workspaceId.toString(), recipientId: agentId, type: 'conversation.transferred',
              title: 'Conversa transferida pra você', message: `${contact?.name ?? contact?.phone ?? 'Um contato'} — transferida por um fluxo`,
              link: '/conversations', metadata: { conversationId: run.conversationId.toString() },
            });
          }
        }
        // Optional handoff message.
        const message = String(node.config.message ?? '').trim();
        if (message) {
          try { await this.deps.sendMessage(run.jid, { text: message } as never); } catch { /* ignore */ }
        }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'attendance.close') {
        // Send the configured closing message before finishing — previously
        // silently ignored, leaving the contact with no closing message at all.
        const closeMessage = interpolate(String(node.config.message ?? ''), ctx).trim();
        if (closeMessage) {
          try { await this.deps.sendMessage(run.jid, { text: closeMessage } as never); } catch { /* ignore */ }
        }
        // Free the ticket on close too (mirrors the resolve endpoint) so a
        // returning contact is re-triaged / eligible for the catch-all again.
        const closeReasonId = String(node.config.closeReasonId ?? '');
        await Conversation.updateOne(
          { _id: run.conversationId },
          {
            status: 'resolved', assignedAgentId: null, resolvedAt: new Date(),
            ...(Types.ObjectId.isValid(closeReasonId) ? { closeReasonId: new Types.ObjectId(closeReasonId) } : {}),
          }
        );
        await clearSlaTimers(run.conversationId.toString());
        run.status = 'completed'; await run.save(); return;
      }
      if (node.blockType === 'attendance.pause') {
        run.status = 'completed'; await run.save(); return; // hand off to a human
      }
      // transfer_queue is the same "route to a team" action as assign_team — the
      // block used to point at a hardcoded, non-existent "queue" enum that never
      // did anything in production; it now reads the same teamGroupId shape.
      if (node.blockType === 'attendance.assign_team' || node.blockType === 'attendance.transfer_queue') {
        const teamGroupId = String(node.config.teamGroupId ?? '');
        if (Types.ObjectId.isValid(teamGroupId)) {
          await Conversation.updateOne(
            { _id: run.conversationId },
            { $set: { teamGroupId: new Types.ObjectId(teamGroupId) } }
          );
          if (this.deps.wsGateway) {
            const memberIds = await resolveNotificationTargets(run.workspaceId.toString(), { targetType: 'team_group', teamGroupId });
            void notifyMany(this.deps.wsGateway, memberIds, {
              workspaceId: run.workspaceId.toString(), type: 'conversation.transferred',
              title: 'Conversa direcionada pra sua equipe', message: `${contact?.name ?? contact?.phone ?? 'Um contato'} — direcionada por um fluxo`,
              link: '/conversations', metadata: { conversationId: run.conversationId.toString() },
            });
          }
          // Dropping into a queue is the natural auto-routing point — try to pick an
          // agent right away instead of leaving it fully unassigned.
          const mode = await getAutoRouteMode(run.workspaceId.toString());
          if (mode !== 'off') void routeConversation(run.conversationId.toString(), this.deps.wsGateway);
        }
        const message = interpolate(String(node.config.message ?? '').trim(), ctx);
        if (message) {
          try { await this.deps.sendMessage(run.jid, { text: message } as never); } catch { /* ignore */ }
        }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'attendance.human_handoff') {
        // Mark conversation as human attendance and end the flow
        await Conversation.updateOne(
          { _id: run.conversationId },
          { $set: { attendanceMode: 'human', attendanceModeChangedAt: new Date(), status: 'open' } }
        );
        const notifyAgentId = String(node.config.notifyAgentId ?? '');
        if (this.deps.wsGateway && Types.ObjectId.isValid(notifyAgentId)) {
          void notify(this.deps.wsGateway, {
            workspaceId: run.workspaceId.toString(), recipientId: notifyAgentId, type: 'flow.transferred_to_human',
            title: 'Bot transferiu uma conversa', message: `${contact?.name ?? contact?.phone ?? 'Um contato'} precisa de atendimento humano`,
            link: '/conversations', metadata: { conversationId: run.conversationId.toString() },
          });
        }
        // Default auto-routing trigger: the bot just handed off to a human — try to
        // pick an available agent now instead of leaving the ticket unassigned.
        if (!Types.ObjectId.isValid(notifyAgentId)) {
          const mode = await getAutoRouteMode(run.workspaceId.toString());
          if (mode === 'on_human' || mode === 'on_new') void routeConversation(run.conversationId.toString(), this.deps.wsGateway);
        }
        const message = interpolate(String(node.config.message ?? '').trim(), ctx);
        if (message) {
          try { await this.deps.sendMessage(run.jid, { text: message } as never); } catch { /* ignore */ }
        }
        run.status = 'completed';
        await run.save();
        return;
      }

      // ── CRM ──────────────────────────────────────────────────────────────────
      if (node.blockType === 'crm.create_lead') {
        try {
          await createLeadFromFlow(run.workspaceId, run.conversationId, {
            pipelineId: String(node.config.pipelineId ?? ''),
            stageId: String(node.config.stageId ?? ''),
            value: Number(node.config.value) || 0,
          });
        } catch (err) { logger.warn({ err, node: node.id }, '[flow] create_lead failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'crm.move_stage') {
        try { await moveLeadForContact(run.workspaceId, run.conversationId, String(node.config.stageId ?? ''), String(node.config.pipelineId ?? '') || undefined); }
        catch (err) { logger.warn({ err, node: node.id }, '[flow] move_stage failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'crm.assign_lead') {
        try {
          await assignLeadForContact(
            run.workspaceId, run.conversationId,
            String(node.config.assigneeId ?? ''), String(node.config.assigneeName ?? '') || undefined
          );
        } catch (err) { logger.warn({ err, node: node.id }, '[flow] assign_lead failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'crm.update_deal_value') {
        try { await updateLeadValueForContact(run.workspaceId, run.conversationId, Number(node.config.value) || 0); }
        catch (err) { logger.warn({ err, node: node.id }, '[flow] update_deal_value failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }
      if (node.blockType === 'crm.add_note') {
        try { await addLeadNoteForContact(run.workspaceId, run.conversationId, interpolate(String(node.config.note ?? ''), ctx)); }
        catch (err) { logger.warn({ err, node: node.id }, '[flow] add_note failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }

      // ── Notification ─────────────────────────────────────────────────────────
      if (node.blockType === 'notification.send') {
        try {
          if (this.deps.wsGateway) {
            const targetType = String(node.config.targetType ?? 'assigned_agent') as NotificationTargetType;
            const recipientIds = await resolveNotificationTargets(run.workspaceId.toString(), {
              targetType,
              agentId: String(node.config.agentId ?? '') || undefined,
              teamGroupId: String(node.config.teamGroupId ?? '') || undefined,
              role: (String(node.config.role ?? '') || undefined) as UserRole | undefined,
              conversationId: run.conversationId.toString(),
            });
            const title = interpolate(String(node.config.title ?? 'Notificação do fluxo').trim(), ctx);
            const message = interpolate(String(node.config.message ?? '').trim(), ctx);
            await notifyMany(this.deps.wsGateway, recipientIds, {
              workspaceId: run.workspaceId.toString(), type: 'flow.custom', title, message,
              link: '/conversations', metadata: { conversationId: run.conversationId.toString(), flowId: flow._id.toString() },
            });
          }
        } catch (err) { logger.warn({ err, node: node.id }, '[flow] notification.send failed'); }
        await this.moveNext(run, edges, node.id, 'out');
        continue;
      }

      // ── Typing indicator ─────────────────────────────────────────────────────
      if (node.blockType === 'automation.typing') {
        const seconds = Math.max(1, Math.min(Number(node.config.duration ?? 3), 20));
        const state = node.config.action === 'recording' ? 'recording' : 'composing';
        try { await this.deps.sendPresence?.(run.jid, state); } catch { /* ignore */ }
        const next = nextNodeId(edges, node.id, 'out');
        run.currentNodeId = next;
        run.status = next ? 'running' : 'completed';
        await run.save();
        const jid = run.jid;
        if (next) setTimeout(() => {
          this.deps.sendPresence?.(jid, 'paused').catch(() => {});
          this.advance(runId, contact, lastInboundKey).catch(() => {});
        }, seconds * 1000);
        return;
      }

      // ── Delay ──────────────────────────────────────────────────────────────
      if (node.blockType === 'automation.delay') {
        const ms = delayMs(node.config);
        const next = nextNodeId(edges, node.id, 'out');
        if (!next) { run.status = 'completed'; await run.save(); return; }
        run.currentNodeId = next;
        // Previously used an in-process setTimeout clamped to 5 minutes — any
        // configured delay longer than that (the block supports hours/days) was
        // silently truncated, and a mid-delay process restart lost the timer
        // entirely, orphaning the run forever. Persist status='delayed' +
        // resumeAt instead; flow-run-scheduler.ts sweeps for these on a timer, so
        // the full configured duration is honored and it survives a restart.
        run.status = 'delayed';
        run.resumeAt = new Date(Date.now() + ms);
        await run.save();
        return;
      }

      // ── Jump to another flow ───────────────────────────────────────────────
      if (node.blockType === 'automation.jump_flow') {
        const targetFlowId = String(node.config.targetFlowId ?? '');
        if (targetFlowId && Types.ObjectId.isValid(targetFlowId)) {
          const targetFlow = await Flow.findById(targetFlowId);
          if (targetFlow) {
            run.status = 'completed';
            await run.save();
            // Carry accumulated variables into the new run so downstream blocks
            // can still use {{variavel}} collected in the originating flow.
            const contact = await this.loadContact(run);
            await this.start(targetFlow, {
              workspaceId: run.workspaceId.toString(),
              instanceId: run.instanceId.toString(),
              conversationId: run.conversationId.toString(),
              jid: run.jid,
              contact,
              lastText: String(run.variables._lastText ?? ''),
              lastInboundKey,
              _inheritedVariables: run.variables,
              _jumpDepth: (run.jumpDepth ?? 0) + 1,
            });
            return;
          } else {
            logger.warn({ node: node.id, targetFlowId }, '[flow] jump_flow: fluxo de destino não encontrado');
          }
        }
        run.status = 'completed';
        await run.save();
        return;
      }

      // ── Automation ───────────────────────────────────────────────────────────
      if (node.blockType === 'automation.webhook') {
        const { url, method, headers, body } = node.config as { url?: string; method?: string; headers?: Record<string, string>; body?: string };
        const httpMethod = (method || 'POST').toUpperCase();
        const resolvedUrl = interpolate(String(url ?? ''), ctx);
        if (!isPublicHttpUrl(resolvedUrl)) {
          logger.warn({ node: node.id, url: resolvedUrl }, '[flow] webhook action blocked — URL is not a public http(s) host');
          await this.moveNext(run, edges, node.id, 'error');
          continue;
        }
        try {
          const res = await fetch(resolvedUrl, {
            method: httpMethod,
            headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
            body: ['GET', 'HEAD'].includes(httpMethod) ? undefined : interpolate(String(body ?? ''), ctx),
            signal: AbortSignal.timeout(10_000),
            // See webhook-dispatcher.ts: don't follow redirects — this URL is chosen
            // by whoever built the flow, and here the attacker also controls the
            // response body (the flow reads res.ok, but a compromised target can still
            // redirect this internal-network-capable request to 169.254.169.254/etc).
            redirect: 'manual',
          });
          await this.moveNext(run, edges, node.id, res.ok ? 'success' : 'error');
        } catch (err) {
          logger.warn({ err, node: node.id }, '[flow] webhook action failed');
          await this.moveNext(run, edges, node.id, 'error');
        }
        continue;
      }

      // ── AI (not implemented for real yet — see BlockPalette "Em breve") ─────
      // ai.classify/ai.sentiment never produce a port literally named 'out' (their
      // ports are intent slugs / positive-neutral-negative), so without this
      // branch they'd reach the generic passthrough below, which only knows how
      // to follow an 'out' edge — find nothing, and silently end the run right
      // here. Follow whichever edge is actually wired instead of guessing a real
      // classification result; still no AI call happens, no variable is saved.
      if (node.blockType === 'ai.ask' || node.blockType === 'ai.classify' || node.blockType === 'ai.sentiment') {
        const next = edges.find((e) => e.source === node.id)?.target;
        run.currentNodeId = next;
        run.status = next ? 'running' : 'completed';
        await run.save();
        continue;
      }

      // ── Passthrough (crm/attendance transfer/trigger) ───────────────────────
      await this.moveNext(run, edges, node.id, 'out');

      } catch (err) {
        // A node throwing (bad timezone config, malformed regex, a DB write
        // failing, etc.) previously propagated up to the caller's best-effort
        // .catch() (BaileysSession's inbound handler), which only logs — leaving
        // this run stuck at status 'running' forever, silently blocking any new
        // trigger for this conversation. Mark it failed instead so it's visible
        // and the conversation can be re-triggered.
        logger.error({ err, runId, node: node.id, blockType: node.blockType }, '[flow] node threw — marking run failed');
        try {
          const failedRun = await FlowRun.findById(runId);
          if (failedRun && failedRun.status === 'running') {
            failedRun.status = 'failed';
            failedRun.failureReason = `Erro no bloco "${node.blockType}": ${err instanceof Error ? err.message : String(err)}`;
            await failedRun.save();
          }
        } catch (saveErr) {
          logger.error({ saveErr, runId }, '[flow] failed to persist failure status after node error');
        }
        return;
      }
    }

    // Loop finished all MAX_STEPS_PER_CALL iterations without the flow reaching a
    // wait/delay/end — previously this just silently returned, leaving the run
    // 'running' forever (and, because handleInboundForFlows blocks a new trigger
    // while a run is 'running', permanently deaf to that contact from then on).
    const exhaustedRun = await FlowRun.findById(runId);
    if (exhaustedRun && exhaustedRun.status === 'running') {
      logger.error({ runId }, '[flow] run exceeded MAX_STEPS_PER_CALL in one advance() call — stopping (likely a tight loop with no delay/wait)');
      exhaustedRun.status = 'failed';
      exhaustedRun.failureReason = 'Muitos passos consecutivos sem pausa — possível loop no fluxo';
      await exhaustedRun.save();
    }
  }

  /**
   * Fire the timeout path of a `wait_response` block. Sends the timeoutMessage
   * (if configured) and continues execution via the 'timeout' output port.
   * Called either from the in-process setTimeout or from handleInboundForFlows
   * when an inbound message arrives after waitingUntil has passed.
   */
  async handleTimeout(run: IFlowRun, contact: FlowContext['contact'], lastInboundKey?: FlowContext['lastInboundKey']): Promise<void> {
    const waitingNodeId = run.waiting?.nodeId;
    if (!waitingNodeId) { run.status = 'completed'; await run.save(); return; }
    // Same atomic-claim reasoning as resume() — the in-process setTimeout and the
    // flow-run scheduler's sweep (or a concurrent resume() from an inbound reply
    // that arrives at the exact same moment) can all race to fire this. Only the
    // caller that wins the claim proceeds.
    const claimed = await FlowRun.findOneAndUpdate(
      { _id: run._id, status: 'waiting', 'waiting.nodeId': waitingNodeId },
      { $set: { status: 'running' } },
      { new: true }
    );
    if (!claimed) return;
    run = claimed;
    const flow = await Flow.findById(run.flowId);
    if (!flow) { run.status = 'completed'; await run.save(); return; }
    if (!flow.enabled) { run.status = 'cancelled'; await run.save(); return; }
    const nodes = normalizeNodes(flow);
    const edges = normalizeEdges(flow);
    const node = nodeById(nodes, waitingNodeId);
    const ctx: FlowContext = { variables: run.variables, contact, lastInboundKey };
    const timeoutMsg = interpolate(String(node?.config.timeoutMessage ?? ''), ctx).trim();
    if (timeoutMsg) {
      try { await this.deps.sendMessage(run.jid, { text: timeoutMsg } as never); } catch { /* ignore */ }
    }
    const next = nextNodeId(edges, waitingNodeId, 'timeout');
    run.waiting = undefined;
    run.currentNodeId = next;
    run.status = next ? 'running' : 'completed';
    await run.save();
    if (next) await this.advance(run._id.toString(), contact, lastInboundKey);
  }

  /**
   * Resume a run parked in status='delayed' (automation.delay past its resumeAt) —
   * called by flow-run-scheduler.ts's sweep. Atomically claims the run first so a
   * scheduler tick can't double-process a run the in-process continuation (when the
   * delay was short enough to use one) already picked up, or vice versa.
   */
  async continueDelayed(runId: string): Promise<void> {
    const claimed = await FlowRun.findOneAndUpdate(
      { _id: runId, status: 'delayed' },
      { $set: { status: 'running' } },
      { new: true }
    );
    if (!claimed) return;
    const contact = await this.loadContact(claimed);
    await this.advance(runId, contact);
  }

  /** Fire a wait_response timeout found by the scheduler's sweep (safety net for
   *  when the in-process timer didn't survive a restart, or was clamped short of
   *  the real target — see action.wait_response above). */
  async continueTimedOut(runId: string): Promise<void> {
    const run = await FlowRun.findById(runId);
    if (!run || run.status !== 'waiting') return;
    const contact = await this.loadContact(run);
    await this.handleTimeout(run, contact);
  }

  private async moveNext(run: IFlowRun, edges: ReturnType<typeof normalizeEdges>, nodeId: string, port: string) {
    const next = nextNodeId(edges, nodeId, port);
    run.currentNodeId = next;
    run.status = next ? 'running' : 'completed';
    await run.save();
  }

  private async applyTag(run: IFlowRun, tag: string, add: boolean) {
    const conv = await Conversation.findById(run.conversationId);
    if (!conv?.contactId) return;
    if (add) {
      await ensureLabel(run.workspaceId.toString(), tag);
      await Contact.updateOne({ _id: conv.contactId }, { $addToSet: { tags: tag } });
      await Conversation.updateOne({ _id: conv._id }, { $addToSet: { tags: tag } });
    } else {
      await Contact.updateOne({ _id: conv.contactId }, { $pull: { tags: tag } });
      await Conversation.updateOne({ _id: conv._id }, { $pull: { tags: tag } });
    }
  }

  /** Mirrors a flow variable into the contact's customFields — used when a
   *  "Definir Variável"/"Salvar Resposta"/"Aguardar Resposta" block has
   *  `persistToContact` on, so the value survives past this one run instead of
   *  only living in `run.variables` for the duration of this flow. Same target
   *  action.update_field already writes to. */
  private async persistVariableToContact(conversationId: Types.ObjectId, varName: string, value: string) {
    try {
      const conv = await Conversation.findById(conversationId).select('contactId').lean();
      if (conv?.contactId) await Contact.updateOne({ _id: conv.contactId }, { $set: { [`customFields.${varName}`]: value } });
    } catch (err) { logger.warn({ err, varName }, '[flow] persistVariableToContact failed'); }
  }
}

function delayMs(config: Record<string, unknown>): number {
  const n = Number(config.duration ?? 0);
  const unit = String(config.unit ?? 'seconds');
  const mult: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  return n * (mult[unit] ?? 1000);
}

function waitResponseTimeoutMs(config: { timeoutDuration?: number; timeoutUnit?: string }): number {
  const n = Math.max(1, Number(config.timeoutDuration ?? 24));
  const unit = String(config.timeoutUnit ?? 'hours');
  const mult: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  return n * (mult[unit] ?? 3_600_000);
}
