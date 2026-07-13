import { Types } from 'mongoose';
import pino from 'pino';
import { Flow, FlowRun, Conversation, Contact } from '../db/models';
import type { IFlow, IFlowNode, IFlowRun, UserRole } from '../db/models';
import { ensureLabel } from '../modules/labels/labels.service';
import { createLeadFromFlow, moveLeadForContact, assignLeadForContact, updateLeadValueForContact, addLeadNoteForContact } from '../modules/crm/crm.service';
import { notify, notifyMany, resolveNotificationTargets, type NotificationTargetType } from '../modules/notifications/notification.service';
import { getAutoRouteMode, routeConversation } from '../modules/routing/routing.service';
import { clearSlaTimers } from '../modules/routing/sla.service';
import { normalizeNodes, normalizeEdges, nodeById, nextNodeId, entryNode } from './graph';
import { buildMessageContent, interpolate, type FlowContext } from './senders';
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

const MAX_STEPS = 50; // guard against loops per advance() call

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
    case 'regex': try { return new RegExp(pattern ?? '').test(input); } catch { return false; }
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
  }): Promise<void> {
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
    });

    await this.advance(run._id.toString(), params.contact, params.lastInboundKey);
  }

  /**
   * Resume a waiting run with an inbound reply (button/list id, or free text).
   * Returns `true` if the run advanced, `false` if the reply didn't match and the
   * run stayed waiting — the caller can then decide to re-trigger a fresh flow.
   */
  async resume(run: IFlowRun, reply: { id?: string; text: string; inboundKey?: FlowContext['lastInboundKey'] }): Promise<boolean> {
    const flow = await Flow.findById(run.flowId);
    if (!flow) return false;
    const edges = normalizeEdges(flow);
    const waiting = run.waiting;
    if (!waiting) return false;

    let port = 'out';
    if (waiting.kind === 'reply') {
      const nodes = normalizeNodes(flow);
      const node = nodeById(nodes, waiting.nodeId);
      const varName = String((node?.config.variableName as string) ?? '');
      if (varName) run.variables = { ...run.variables, [varName]: reply.text };
      // wait_response uses 'resposta' as its success port; save_response uses 'out'.
      if (node?.blockType === 'action.wait_response') port = 'resposta';
    } else if (reply.id && waiting.portIds.includes(reply.id)) {
      port = reply.id;
    } else {
      // Reply didn't match any option — stay waiting.
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

  /** Execute nodes sequentially until the flow waits, delays or ends. */
  private async advance(runId: string, contact: FlowContext['contact'], lastInboundKey?: FlowContext['lastInboundKey']): Promise<void> {
    for (let step = 0; step < MAX_STEPS; step++) {
      const run = await FlowRun.findById(runId);
      if (!run || run.status !== 'running' || !run.currentNodeId) return;
      const flow = await Flow.findById(run.flowId);
      if (!flow) return;
      const nodes = normalizeNodes(flow);
      const edges = normalizeEdges(flow);
      const node = nodeById(nodes, run.currentNodeId);
      if (!node) { run.status = 'completed'; await run.save(); return; }

      const ctx: FlowContext = { variables: run.variables, contact, lastInboundKey };

      // ── Send message / payment blocks ──────────────────────────────────────
      if (node.blockType.startsWith('message.') || node.blockType.startsWith('payment.')) {
        const content = buildMessageContent(node, ctx);
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
          // condition.if — tag conditions need the conversation's live tags.
          if ((node.config as { field?: string }).field === 'contact_tag') {
            const conv = await Conversation.findById(run.conversationId).lean();
            ctx.variables._tags = (conv?.tags ?? []).join(',');
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
        // Best-effort in-process timeout scheduler (does not survive restart;
        // handleInboundForFlows checks waitingUntil on next inbound as a safety net).
        if (waitingUntil) {
          const delayMs = Math.max(0, waitingUntil.getTime() - Date.now());
          const runId = run._id.toString();
          const nodeId = node.id;
          setTimeout(async () => {
            try {
              const r = await FlowRun.findById(runId);
              if (r?.status === 'waiting' && r.waiting?.nodeId === nodeId) {
                await this.handleTimeout(r, contact, lastInboundKey);
              }
            } catch { /* ignore */ }
          }, delayMs);
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
        // Free the ticket on close too (mirrors the resolve endpoint) so a
        // returning contact is re-triaged / eligible for the catch-all again.
        await Conversation.updateOne({ _id: run.conversationId }, { status: 'resolved', assignedAgentId: null });
        await clearSlaTimers(run.conversationId.toString());
        run.status = 'completed'; await run.save(); return;
      }
      if (node.blockType === 'attendance.pause') {
        run.status = 'completed'; await run.save(); return; // hand off to a human
      }
      if (node.blockType === 'attendance.assign_team') {
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
        try { await moveLeadForContact(run.workspaceId, run.conversationId, String(node.config.stageId ?? '')); }
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
        run.currentNodeId = next;
        run.status = next ? 'running' : 'completed';
        await run.save();
        if (next) setTimeout(() => { this.advance(runId, contact, lastInboundKey).catch(() => {}); }, Math.min(ms, 5 * 60_000));
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
        try {
          const res = await fetch(interpolate(String(url ?? ''), ctx), {
            method: httpMethod,
            headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
            body: ['GET', 'HEAD'].includes(httpMethod) ? undefined : interpolate(String(body ?? ''), ctx),
            signal: AbortSignal.timeout(10_000),
          });
          await this.moveNext(run, edges, node.id, res.ok ? 'success' : 'error');
        } catch (err) {
          logger.warn({ err, node: node.id }, '[flow] webhook action failed');
          await this.moveNext(run, edges, node.id, 'error');
        }
        continue;
      }

      // ── Passthrough (crm/ai/attendance transfer/trigger) ───────────────────
      await this.moveNext(run, edges, node.id, 'out');
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
    const flow = await Flow.findById(run.flowId);
    if (!flow) { run.status = 'completed'; await run.save(); return; }
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
