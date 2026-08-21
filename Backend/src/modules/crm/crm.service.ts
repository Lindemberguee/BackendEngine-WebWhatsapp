/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Pipeline, Lead, Contact, Conversation, LeadActivity, User } from '../../db/models';
import type { LeadActivityType } from '../../db/models';

/** Resolve a user id (JWT `sub`) to a display name for activity-log attribution. */
export async function getActorName(userId?: string): Promise<string | undefined> {
  if (!userId || !Types.ObjectId.isValid(userId)) return undefined;
  const user = await User.findById(userId).select('name').lean();
  return user?.name;
}

export const DEFAULT_STAGES = [
  { id: 'lead',        name: 'Lead',        order: 0, color: '#64748B', kind: 'open' as const, probability: 10 },
  { id: 'qualified',   name: 'Qualificado', order: 1, color: '#3B82F6', kind: 'open' as const, probability: 30 },
  { id: 'proposal',    name: 'Proposta',    order: 2, color: '#8B5CF6', kind: 'open' as const, probability: 50 },
  { id: 'negotiation', name: 'Negociação',  order: 3, color: '#F59E0B', kind: 'open' as const, probability: 75 },
  { id: 'won',         name: 'Ganho',       order: 4, color: '#10B981', kind: 'won' as const, probability: 100 },
  { id: 'lost',        name: 'Perdido',     order: 5, color: '#EF4444', kind: 'lost' as const, probability: 0 },
];

/** Fallback probability by stage kind when a stage has none set explicitly. */
export function defaultProbabilityForKind(kind: StageKindLike): number {
  if (kind === 'won') return 100;
  if (kind === 'lost') return 0;
  return 50;
}
type StageKindLike = 'open' | 'won' | 'lost';

/** Return the workspace's default pipeline, creating a seeded one if none exists. */
export async function ensureDefaultPipeline(workspaceId: string) {
  const wid = new Types.ObjectId(workspaceId);
  let pipeline = await Pipeline.findOne({ workspaceId: wid, archived: { $ne: true } }).sort({ isDefault: -1, createdAt: 1 });
  if (!pipeline) {
    pipeline = await Pipeline.create({ workspaceId: wid, name: 'Funil de Vendas', stages: DEFAULT_STAGES, isDefault: true });
  }
  return pipeline;
}

/** Flatten a Lead doc (with populated contact/assignee) into the API response. */
export function toLeadResponse(doc: any) {
  const contact = doc.contactId && typeof doc.contactId === 'object' && doc.contactId.name ? doc.contactId : null;
  const assignee = doc.assigneeId && typeof doc.assigneeId === 'object' && doc.assigneeId.name ? doc.assigneeId : null;
  return {
    id: doc._id?.toString(),
    pipelineId: doc.pipelineId?.toString(),
    stageId: doc.stageId,
    contactId: (contact?._id ?? doc.contactId)?.toString(),
    conversationId: doc.conversationId?.toString(),
    title: doc.title,
    value: doc.value ?? 0,
    currency: doc.currency ?? 'BRL',
    assigneeId: (assignee?._id ?? doc.assigneeId)?.toString(),
    assigneeName: assignee?.name,
    tags: doc.tags ?? [],
    notes: doc.notes ?? '',
    customFields: doc.customFields instanceof Map ? Object.fromEntries(doc.customFields) : (doc.customFields ?? {}),
    status: doc.status ?? 'open',
    order: doc.order ?? 0,
    source: doc.source ?? 'manual',
    expectedCloseDate: doc.expectedCloseDate?.toISOString?.(),
    wonAt: doc.wonAt?.toISOString?.(),
    lostAt: doc.lostAt?.toISOString?.(),
    lostReason: doc.lostReason,
    lastActivityAt: doc.lastActivityAt?.toISOString?.(),
    createdAt: doc.createdAt?.toISOString?.(),
    updatedAt: doc.updatedAt?.toISOString?.(),
    contact: contact ? { id: contact._id.toString(), name: contact.name, phone: contact.phone, avatarUrl: contact.avatarUrl, email: contact.email } : undefined,
  };
}

/** Next order value (end of stage). */
export async function nextOrder(workspaceId: Types.ObjectId, pipelineId: Types.ObjectId, stageId: string): Promise<number> {
  const last = await Lead.findOne({ workspaceId, pipelineId, stageId }).sort({ order: -1 }).select('order');
  return (last?.order ?? -1) + 1;
}

/**
 * Sales report for a pipeline: per-stage breakdown with a probability-weighted
 * forecast, a per-agent win-rate leaderboard, and a lost-reason breakdown.
 * Scoped to open leads for the forecast/stage numbers; won/lost leads feed the
 * agent leaderboard and lost-reason breakdown.
 */
export async function getCrmReport(workspaceId: string, pipelineId: string, range?: { from?: Date; to?: Date }) {
  const pipeline = await Pipeline.findOne({ _id: pipelineId, workspaceId });
  if (!pipeline) return null;

  const leads = await Lead.find({ workspaceId, pipelineId }).populate('assigneeId', 'name').lean();
  // Date range only scopes closed leads (won/lost by their close date) — open
  // leads always reflect the current, live pipeline regardless of period.
  const inRange = (d?: Date) => {
    if (!range?.from && !range?.to) return true;
    if (!d) return false;
    if (range.from && d < range.from) return false;
    if (range.to && d > range.to) return false;
    return true;
  };
  const open = leads.filter((l) => l.status === 'open');
  const won = leads.filter((l) => l.status === 'won' && inRange(l.wonAt));
  const lost = leads.filter((l) => l.status === 'lost' && inRange(l.lostAt));

  const byStage = pipeline.stages
    .filter((s) => s.kind === 'open')
    .map((s) => {
      const stageLeads = open.filter((l) => l.stageId === s.id);
      const value = stageLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
      const probability = s.probability ?? defaultProbabilityForKind(s.kind);
      return {
        stageId: s.id, stageName: s.name, color: s.color, probability,
        count: stageLeads.length, value, weightedValue: Math.round(value * (probability / 100)),
      };
    });

  const forecast = byStage.reduce((sum, s) => sum + s.weightedValue, 0);
  const pipelineValue = open.reduce((sum, l) => sum + (l.value ?? 0), 0);
  const wonValue = won.reduce((sum, l) => sum + (l.value ?? 0), 0);
  const closedCount = won.length + lost.length;
  const conversionRate = closedCount > 0 ? Math.round((won.length / closedCount) * 100) : 0;

  const agentMap = new Map<string, { agentId: string; agentName: string; won: number; lost: number; wonValue: number }>();
  for (const l of [...won, ...lost]) {
    const assignee = l.assigneeId as unknown as { _id: Types.ObjectId; name: string } | undefined;
    const id = assignee?._id?.toString() ?? 'unassigned';
    const name = assignee?.name ?? 'Sem responsável';
    const entry = agentMap.get(id) ?? { agentId: id, agentName: name, won: 0, lost: 0, wonValue: 0 };
    if (l.status === 'won') { entry.won += 1; entry.wonValue += l.value ?? 0; }
    else entry.lost += 1;
    agentMap.set(id, entry);
  }
  const byAgent = [...agentMap.values()]
    .map((a) => ({ ...a, winRate: a.won + a.lost > 0 ? Math.round((a.won / (a.won + a.lost)) * 100) : 0 }))
    .sort((a, b) => b.wonValue - a.wonValue);

  const reasonMap = new Map<string, number>();
  for (const l of lost) {
    const reason = l.lostReason?.trim() || 'Sem motivo informado';
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }
  const lostReasons = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const stageTimings = await getStageTimings(workspaceId, pipelineId, pipeline);

  return { pipelineId, pipelineValue, wonValue, forecast, conversionRate, byStage, byAgent, lostReasons, stageTimings };
}

export interface StageTiming {
  stageId: string;
  stageName: string;
  avgDays: number;
  sampleCount: number;
}

/**
 * Average time spent in each open stage, derived from LeadActivity's
 * 'created'/'stage_changed' history (timestamps only — no new model needed).
 * Only counts *completed* stays (a stage that was later left via a kanban
 * move/PATCH-driven stage_changed) — leads still sitting in a stage, or ones
 * closed directly via the Ganhar/Perder buttons (which log 'won'/'lost'
 * instead of 'stage_changed' and don't carry a toStageId), aren't counted.
 * A known v1 simplification, not a bug: the average is still representative
 * for pipelines where stage moves happen via drag-and-drop/kanban.
 */
export async function getStageTimings(
  workspaceId: string, pipelineId: string, preloadedPipeline?: { stages: { id: string; name: string; kind: string; order: number }[] }
): Promise<StageTiming[]> {
  const pipeline = preloadedPipeline ?? (await Pipeline.findOne({ _id: pipelineId, workspaceId }).lean());
  if (!pipeline) return [];

  const leadIds = await Lead.find({ workspaceId, pipelineId }).select('_id').lean();
  if (leadIds.length === 0) return [];

  const activities = await LeadActivity.find({
    workspaceId, leadId: { $in: leadIds.map((l) => l._id) },
    type: { $in: ['created', 'stage_changed'] },
  }).sort({ leadId: 1, createdAt: 1 }).lean();

  const durations = new Map<string, { totalMs: number; count: number }>();
  let currentLeadId = '';
  let currentStageId: string | null = null;
  let enteredAt: Date | null = null;
  const firstStageId = [...pipeline.stages].sort((a, b) => a.order - b.order)[0]?.id ?? null;

  for (const a of activities) {
    const leadId = a.leadId.toString();
    if (leadId !== currentLeadId) {
      currentLeadId = leadId;
      currentStageId = null;
      enteredAt = null;
    }
    if (a.type === 'created') {
      currentStageId = firstStageId;
      enteredAt = a.createdAt;
    } else if (a.type === 'stage_changed') {
      if (currentStageId && enteredAt) {
        const ms = a.createdAt.getTime() - enteredAt.getTime();
        const entry = durations.get(currentStageId) ?? { totalMs: 0, count: 0 };
        entry.totalMs += ms;
        entry.count += 1;
        durations.set(currentStageId, entry);
      }
      const toStageId = (a.metadata as { toStageId?: string } | undefined)?.toStageId;
      currentStageId = toStageId ?? currentStageId;
      enteredAt = a.createdAt;
    }
  }

  const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;
  return pipeline.stages
    .filter((s) => s.kind === 'open')
    .map((s) => {
      const d = durations.get(s.id);
      return {
        stageId: s.id,
        stageName: s.name,
        avgDays: d && d.count > 0 ? Math.round((d.totalMs / d.count / DAY_MS_LOCAL) * 10) / 10 : 0,
        sampleCount: d?.count ?? 0,
      };
    })
    .filter((s) => s.sampleCount > 0);
}

/**
 * Cross-pipeline rollup — same shape of numbers as getCrmReport (forecast,
 * conversion rate, agent leaderboard, lost reasons) but summed across every
 * non-archived pipeline in the workspace, plus a per-pipeline breakdown table.
 * No per-stage breakdown here (stages differ across pipelines) — use
 * getCrmReport for a single funnel's "Por estágio" view.
 */
export async function getCrossPipelineReport(workspaceId: string, range?: { from?: Date; to?: Date }) {
  const pipelines = await Pipeline.find({ workspaceId, archived: { $ne: true } });
  if (pipelines.length === 0) return null;

  const inRange = (d?: Date) => {
    if (!range?.from && !range?.to) return true;
    if (!d) return false;
    if (range.from && d < range.from) return false;
    if (range.to && d > range.to) return false;
    return true;
  };

  const allLeads = await Lead.find({ workspaceId, pipelineId: { $in: pipelines.map((p) => p._id) } })
    .populate('assigneeId', 'name')
    .lean();

  let pipelineValue = 0;
  let wonValue = 0;
  let forecast = 0;
  let totalWon = 0;
  let totalLost = 0;
  const agentMap = new Map<string, { agentId: string; agentName: string; won: number; lost: number; wonValue: number }>();
  const reasonMap = new Map<string, number>();
  const byPipeline: { pipelineId: string; name: string; openValue: number; wonValue: number; conversionRate: number }[] = [];

  for (const pipeline of pipelines) {
    const pid = pipeline._id.toString();
    const leads = allLeads.filter((l) => l.pipelineId.toString() === pid);
    const open = leads.filter((l) => l.status === 'open');
    const won = leads.filter((l) => l.status === 'won' && inRange(l.wonAt));
    const lost = leads.filter((l) => l.status === 'lost' && inRange(l.lostAt));

    const openValue = open.reduce((sum, l) => sum + (l.value ?? 0), 0);
    const pipelineWonValue = won.reduce((sum, l) => sum + (l.value ?? 0), 0);
    const closedCount = won.length + lost.length;
    const conversionRate = closedCount > 0 ? Math.round((won.length / closedCount) * 100) : 0;

    pipelineValue += openValue;
    wonValue += pipelineWonValue;
    totalWon += won.length;
    totalLost += lost.length;

    for (const s of pipeline.stages.filter((st) => st.kind === 'open')) {
      const stageLeads = open.filter((l) => l.stageId === s.id);
      const value = stageLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
      const probability = s.probability ?? defaultProbabilityForKind(s.kind);
      forecast += Math.round(value * (probability / 100));
    }

    for (const l of [...won, ...lost]) {
      const assignee = l.assigneeId as unknown as { _id: Types.ObjectId; name: string } | undefined;
      const id = assignee?._id?.toString() ?? 'unassigned';
      const name = assignee?.name ?? 'Sem responsável';
      const entry = agentMap.get(id) ?? { agentId: id, agentName: name, won: 0, lost: 0, wonValue: 0 };
      if (l.status === 'won') { entry.won += 1; entry.wonValue += l.value ?? 0; }
      else entry.lost += 1;
      agentMap.set(id, entry);
    }
    for (const l of lost) {
      const reason = l.lostReason?.trim() || 'Sem motivo informado';
      reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
    }

    byPipeline.push({ pipelineId: pid, name: pipeline.name, openValue, wonValue: pipelineWonValue, conversionRate });
  }

  const conversionRate = totalWon + totalLost > 0 ? Math.round((totalWon / (totalWon + totalLost)) * 100) : 0;
  const byAgent = [...agentMap.values()]
    .map((a) => ({ ...a, winRate: a.won + a.lost > 0 ? Math.round((a.won / (a.won + a.lost)) * 100) : 0 }))
    .sort((a, b) => b.wonValue - a.wonValue);
  const lostReasons = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return { pipelineValue, wonValue, forecast, conversionRate, byPipeline, byAgent, lostReasons };
}

/** Append an entry to a lead's activity log. Never throws — a logging failure must not break the caller's action. */
export async function logLeadActivity(params: {
  workspaceId: Types.ObjectId | string;
  leadId: Types.ObjectId | string;
  type: LeadActivityType;
  message: string;
  actorId?: string;
  actorName?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await LeadActivity.create({
      workspaceId: params.workspaceId,
      leadId: params.leadId,
      type: params.type,
      message: params.message,
      actorId: params.actorId && Types.ObjectId.isValid(params.actorId) ? params.actorId : undefined,
      actorName: params.actorName,
      metadata: params.metadata,
    });
  } catch {
    // best-effort — never block the caller's mutation on activity logging
  }
}

/** Find the contact's most recent OPEN lead — shared by the flow blocks that act "on the current deal". */
async function findOpenLeadForContact(workspaceId: Types.ObjectId, conversationId: Types.ObjectId) {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv?.contactId) return null;
  return Lead.findOne({ workspaceId, contactId: conv.contactId, status: 'open' }).sort({ updatedAt: -1 });
}

/**
 * Auto-create a lead when a brand-new conversation starts, if any pipeline has
 * opted in via `autoCreateFromConversation`. Skips the contact if it already
 * has an open lead (avoids duplicate opportunities on repeat inbound messages
 * for a conversation that raced this check twice). Never throws.
 */
export async function maybeAutoCreateLeadFromConversation(
  workspaceId: string, conversationId: Types.ObjectId, contactId: Types.ObjectId, contactName?: string
): Promise<void> {
  try {
    const wid = new Types.ObjectId(workspaceId);
    const pipeline = await Pipeline.findOne({ workspaceId: wid, archived: { $ne: true }, autoCreateFromConversation: true });
    if (!pipeline) return;
    const existing = await Lead.findOne({ workspaceId: wid, contactId, status: 'open' });
    if (existing) return;
    const stageId = pipeline.stages.find((s) => s.kind === 'open')?.id ?? pipeline.stages[0]?.id;
    if (!stageId) return;
    const lead = await Lead.create({
      workspaceId: wid, pipelineId: pipeline._id, stageId, contactId, conversationId,
      title: contactName || 'Novo lead', source: 'conversation',
      order: await nextOrder(wid, pipeline._id as Types.ObjectId, stageId),
    });
    await logLeadActivity({
      workspaceId: wid, leadId: lead._id, type: 'created',
      message: 'Lead criado automaticamente ao iniciar a conversa', actorName: 'Automação',
    });
  } catch {
    // best-effort — a failed auto-create must never break message processing
  }
}

// ─── Flow integration ─────────────────────────────────────────────────────────

/** crm.create_lead — create a lead for the conversation's contact. */
export async function createLeadFromFlow(
  workspaceId: Types.ObjectId, conversationId: Types.ObjectId,
  cfg: { pipelineId?: string; stageId?: string; value?: number },
) {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv?.contactId) return null;
  const pipeline = cfg.pipelineId && Types.ObjectId.isValid(cfg.pipelineId)
    ? await Pipeline.findOne({ _id: cfg.pipelineId, workspaceId })
    : await ensureDefaultPipeline(workspaceId.toString());
  if (!pipeline) return null;
  const stageId = cfg.stageId && pipeline.stages.some((s) => s.id === cfg.stageId) ? cfg.stageId : pipeline.stages[0]?.id;
  if (!stageId) return null;
  const contact = await Contact.findById(conv.contactId).lean();
  const lead = await Lead.create({
    workspaceId, pipelineId: pipeline._id, stageId,
    contactId: conv.contactId, conversationId,
    title: contact?.name || conv.name || 'Novo lead',
    value: Number(cfg.value) || 0, source: 'flow',
    tags: conv.tags ?? [], assigneeId: conv.assignedAgentId ?? undefined,
    order: await nextOrder(workspaceId, pipeline._id as Types.ObjectId, stageId),
  });
  await logLeadActivity({
    workspaceId, leadId: lead._id, type: 'created',
    message: 'Lead criado automaticamente por um fluxo', actorName: 'Automação',
  });
  return lead;
}

/** condition.if field="crm_stage" — display name of the contact's current open
 *  lead's stage, live from the DB (mirrors how "contact_tag" is resolved). */
export async function getOpenLeadStageName(workspaceId: Types.ObjectId, conversationId: Types.ObjectId): Promise<string> {
  const lead = await findOpenLeadForContact(workspaceId, conversationId);
  if (!lead) return '';
  const pipeline = await Pipeline.findById(lead.pipelineId).lean();
  return pipeline?.stages.find((s) => s.id === lead.stageId)?.name ?? '';
}

/** crm.move_stage — move the contact's most recent OPEN lead to a stage. When
 *  `pipelineId` is given (the funnel selected in the block) it must match the
 *  lead's actual pipeline — otherwise the move is skipped rather than silently
 *  applying a stage id from the wrong funnel to whatever pipeline the lead
 *  happens to be in. */
export async function moveLeadForContact(workspaceId: Types.ObjectId, conversationId: Types.ObjectId, stageId: string, pipelineId?: string) {
  const lead = await findOpenLeadForContact(workspaceId, conversationId);
  if (!lead) return null;
  if (pipelineId && Types.ObjectId.isValid(pipelineId) && lead.pipelineId.toString() !== pipelineId) return null;
  const pipeline = await Pipeline.findById(lead.pipelineId);
  const stage = pipeline?.stages.find((s) => s.id === stageId);
  if (!stage) return null;
  const fromStageName = pipeline?.stages.find((s) => s.id === lead.stageId)?.name ?? lead.stageId;
  lead.stageId = stageId;
  lead.lastActivityAt = new Date();
  if (stage.kind === 'won') { lead.status = 'won'; lead.wonAt = new Date(); }
  else if (stage.kind === 'lost') { lead.status = 'lost'; lead.lostAt = new Date(); }
  else lead.status = 'open';
  lead.order = await nextOrder(workspaceId, lead.pipelineId as Types.ObjectId, stageId);
  await lead.save();
  await logLeadActivity({
    workspaceId, leadId: lead._id, type: 'stage_changed',
    message: `Movido automaticamente de "${fromStageName}" para "${stage.name}"`, actorName: 'Automação',
    metadata: { fromStageId: fromStageName, toStageId: stageId },
  });
  return lead;
}

/** crm.assign_lead — assign the contact's most recent OPEN lead to a team member. */
export async function assignLeadForContact(workspaceId: Types.ObjectId, conversationId: Types.ObjectId, assigneeId: string, assigneeName?: string) {
  const lead = await findOpenLeadForContact(workspaceId, conversationId);
  if (!lead) return null;
  lead.assigneeId = Types.ObjectId.isValid(assigneeId) ? (new Types.ObjectId(assigneeId) as any) : undefined;
  lead.lastActivityAt = new Date();
  await lead.save();
  await logLeadActivity({
    workspaceId, leadId: lead._id, type: 'assigned',
    message: assigneeName ? `Atribuído a ${assigneeName} por um fluxo` : 'Responsável atualizado por um fluxo',
    actorName: 'Automação',
  });
  return lead;
}

/** crm.update_deal_value — set the deal value on the contact's most recent OPEN lead. */
export async function updateLeadValueForContact(workspaceId: Types.ObjectId, conversationId: Types.ObjectId, value: number) {
  const lead = await findOpenLeadForContact(workspaceId, conversationId);
  if (!lead) return null;
  const from = lead.value;
  lead.value = Number(value) || 0;
  lead.lastActivityAt = new Date();
  await lead.save();
  await logLeadActivity({
    workspaceId, leadId: lead._id, type: 'value_changed',
    message: `Valor atualizado de R$ ${from.toFixed(2)} para R$ ${lead.value.toFixed(2)} por um fluxo`, actorName: 'Automação',
    metadata: { from, to: lead.value },
  });
  return lead;
}

/** crm.add_note — append a timestamped note to the contact's most recent OPEN lead's activity log. */
export async function addLeadNoteForContact(workspaceId: Types.ObjectId, conversationId: Types.ObjectId, note: string) {
  const lead = await findOpenLeadForContact(workspaceId, conversationId);
  if (!lead || !note.trim()) return null;
  lead.lastActivityAt = new Date();
  await lead.save();
  await logLeadActivity({
    workspaceId, leadId: lead._id, type: 'note_added',
    message: note.trim(), actorName: 'Automação',
  });
  return lead;
}
