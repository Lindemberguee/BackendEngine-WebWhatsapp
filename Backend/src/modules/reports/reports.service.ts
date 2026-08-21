import { Types } from 'mongoose';
import { Conversation, TeamGroup, User, CloseReason } from '../../db/models';
import { addDays, daysBetween, emptyDailyBuckets } from '../../shared/date-range';

export interface ReportFilters {
  workspaceId: string;
  from: Date;
  to: Date;
  teamGroupId?: string;
  agentId?: string;
}

export interface ReportRow {
  id: string | null;
  name: string;
  emoji?: string | null;
  color?: string | null;
  total: number;
  resolved: number;
  open: number;
  blocked: number;
  resolutionRate: number;
}

export interface CloseReasonRow {
  id: string | null;
  label: string;
  color: string;
  total: number;
  byTeam: { id: string | null; name: string; count: number }[];
  byAgent: { id: string | null; name: string; count: number }[];
}

export interface ReportSummary {
  period: { from: string; to: string };
  overview: {
    totalCreated: number;
    openNow: number;
    resolvedInRange: number;
    blocked: number;
    resolutionRate: number;
    /** Minutes between a conversation's creation and the agent's first outbound reply. `null` when no conversation in range has one yet. */
    avgFirstResponseMinutes: number | null;
    slaFirstResponseBreachRate: number;
    slaResolutionBreachRate: number;
  };
  /** % change vs. the immediately preceding period of equal length. */
  deltas: {
    totalCreated: number;
    resolvedInRange: number;
    blocked: number;
    resolutionRate: number;
  };
  trend: { date: string; created: number; resolved: number }[];
  /** Current attendance mode of conversations created in the period — a
   *  snapshot, not a history (a conversation started by the bot and later
   *  handed to a human only counts under its *current* mode). */
  attendanceMode: { bot: number; human: number; idle: number };
  byTeam: ReportRow[];
  byAgent: ReportRow[];
  closeReasons: CloseReasonRow[];
}

const NONE_KEY = 'none';

/** Groups conversations matching `match` by `groupField`, counting documents. */
async function countByGroup(match: Record<string, unknown>, groupField: string): Promise<Map<string, number>> {
  const rows = await Conversation.aggregate<{ _id: Types.ObjectId | null; count: number }>([
    { $match: match },
    { $group: { _id: `$${groupField}`, count: { $sum: 1 } } },
  ]);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r._id ? r._id.toString() : NONE_KEY, r.count);
  return map;
}

/** Same as `countByGroup` but only counts conversations whose linked Contact is
 *  currently blocked — "blocked" lives on Contact.status, not on Conversation. */
async function countBlockedByGroup(match: Record<string, unknown>, groupField: string): Promise<Map<string, number>> {
  const rows = await Conversation.aggregate<{ _id: Types.ObjectId | null; count: number }>([
    { $match: match },
    { $lookup: { from: 'contacts', localField: 'contactId', foreignField: '_id', as: 'contact' } },
    { $unwind: '$contact' },
    { $match: { 'contact.status': 'blocked' } },
    { $group: { _id: `$${groupField}`, count: { $sum: 1 } } },
  ]);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r._id ? r._id.toString() : NONE_KEY, r.count);
  return map;
}

function mergeKeys(...maps: Map<string, number>[]): string[] {
  const keys = new Set<string>();
  for (const m of maps) for (const k of m.keys()) keys.add(k);
  return Array.from(keys);
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function delta(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

interface LiteOverview {
  totalCreated: number;
  resolvedInRange: number;
  blocked: number;
}

/** A cheap version of the overview KPIs (no team/agent/close-reason
 *  breakdowns) — used to compute the previous-period comparison without
 *  doubling every aggregation in `buildReportSummary`. */
async function buildLiteOverview(baseFilter: Record<string, unknown>, from: Date, to: Date): Promise<LiteOverview> {
  const createdMatch = { ...baseFilter, createdAt: { $gte: from, $lte: to } };
  const resolvedMatch = { ...baseFilter, status: 'resolved', resolvedAt: { $gte: from, $lte: to } };
  const [totalCreated, resolvedInRange, blockedRows] = await Promise.all([
    Conversation.countDocuments(createdMatch),
    Conversation.countDocuments(resolvedMatch),
    Conversation.aggregate<{ count: number }>([
      { $match: createdMatch },
      { $lookup: { from: 'contacts', localField: 'contactId', foreignField: '_id', as: 'contact' } },
      { $unwind: '$contact' },
      { $match: { 'contact.status': 'blocked' } },
      { $count: 'count' },
    ]),
  ]);
  return { totalCreated, resolvedInRange, blocked: blockedRows[0]?.count ?? 0 };
}

/**
 * Builds the full reports summary: overview KPIs + breakdowns by team, by
 * agent, and by closing reason (itself cross-tabbed by team/agent). Every
 * overview total is a *sum of the same by-team breakdown maps* (not a
 * separate query) so the KPIs and the table rows are guaranteed to add up —
 * this is the "fiel aos números" guarantee the report needs.
 */
export async function buildReportSummary(filters: ReportFilters): Promise<ReportSummary> {
  const { workspaceId, from, to, teamGroupId, agentId } = filters;
  const wsOid = new Types.ObjectId(workspaceId);

  const baseFilter: Record<string, unknown> = { workspaceId: wsOid };
  if (teamGroupId && Types.ObjectId.isValid(teamGroupId)) baseFilter.teamGroupId = new Types.ObjectId(teamGroupId);
  if (agentId && Types.ObjectId.isValid(agentId)) baseFilter.assignedAgentId = new Types.ObjectId(agentId);

  // Created in range: the cohort of conversations that entered the system during [from, to].
  const createdMatch = { ...baseFilter, createdAt: { $gte: from, $lte: to } };
  // Resolved in range: conversations actually closed during [from, to] — may have been
  // created before the period started, that's expected for a "closures" cohort.
  const resolvedMatch = { ...baseFilter, status: 'resolved', resolvedAt: { $gte: from, $lte: to } };
  // Open / blocked are current-state snapshots, not time-bound events — but
  // still scoped to the "created in range" cohort (not a global count) so
  // every column in the same table row is about the same set of conversations
  // and the numbers don't silently ignore the date filter.
  const openMatch = { ...baseFilter, status: 'open' };

  // Previous period of equal length, for the delta arrows on the KPI cards.
  const span = Math.max(1, daysBetween(from, to));
  const prevFrom = addDays(from, -span);
  const prevTo = from;

  const [
    createdByTeam, resolvedByTeam, openByTeam, blockedByTeam,
    createdByAgent, resolvedByAgent, openByAgent, blockedByAgent,
    trendCreatedRows, trendResolvedRows,
    attendanceModeRows, slaRows, firstResponseRows,
    prevOverview,
    closeReasonByTeamRows, closeReasonByAgentRows,
    teamGroups, users, closeReasonsDocs,
  ] = await Promise.all([
    countByGroup(createdMatch, 'teamGroupId'),
    countByGroup(resolvedMatch, 'teamGroupId'),
    countByGroup(openMatch, 'teamGroupId'),
    countBlockedByGroup(createdMatch, 'teamGroupId'),

    countByGroup(createdMatch, 'assignedAgentId'),
    countByGroup(resolvedMatch, 'assignedAgentId'),
    countByGroup(openMatch, 'assignedAgentId'),
    countBlockedByGroup(createdMatch, 'assignedAgentId'),

    // Daily trend: created vs. resolved per calendar day (America/Sao_Paulo, same as Analytics).
    Conversation.aggregate<{ _id: string; count: number }>([
      { $match: createdMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'America/Sao_Paulo' } }, count: { $sum: 1 } } },
    ]),
    Conversation.aggregate<{ _id: string; count: number }>([
      { $match: resolvedMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$resolvedAt', timezone: 'America/Sao_Paulo' } }, count: { $sum: 1 } } },
    ]),

    // Bot vs. human vs. idle — current mode of conversations created in the period.
    Conversation.aggregate<{ _id: string | null; count: number }>([
      { $match: createdMatch },
      { $group: { _id: '$attendanceMode', count: { $sum: 1 } } },
    ]),

    // SLA breach rates — of conversations created in the period.
    Conversation.aggregate<{ total: number; firstResponseBreached: number; resolutionBreached: number }>([
      { $match: createdMatch },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        firstResponseBreached: { $sum: { $cond: ['$slaFirstResponseBreached', 1, 0] } },
        resolutionBreached: { $sum: { $cond: ['$slaResolutionBreached', 1, 0] } },
      } },
    ]),

    // Average first-response time (minutes) — only conversations that already got one.
    Conversation.aggregate<{ avgMinutes: number | null }>([
      { $match: { ...createdMatch, firstRespondedAt: { $ne: null } } },
      { $project: { minutes: { $divide: [{ $subtract: ['$firstRespondedAt', '$createdAt'] }, 60_000] } } },
      { $group: { _id: null, avgMinutes: { $avg: '$minutes' } } },
    ]),

    buildLiteOverview(baseFilter, prevFrom, prevTo),

    Conversation.aggregate<{ _id: { reason: Types.ObjectId | null; team: Types.ObjectId | null }; count: number }>([
      { $match: resolvedMatch },
      { $group: { _id: { reason: '$closeReasonId', team: '$teamGroupId' }, count: { $sum: 1 } } },
    ]),
    Conversation.aggregate<{ _id: { reason: Types.ObjectId | null; agent: Types.ObjectId | null }; count: number }>([
      { $match: resolvedMatch },
      { $group: { _id: { reason: '$closeReasonId', agent: '$assignedAgentId' }, count: { $sum: 1 } } },
    ]),

    TeamGroup.find({ workspaceId: wsOid }).select('name emoji color').lean(),
    User.find({ workspaceId: wsOid }).select('name').lean(),
    CloseReason.find({ workspaceId: wsOid }).select('label color').lean(),
  ]);

  const teamMap = new Map(teamGroups.map((t) => [t._id.toString(), { name: t.name, emoji: t.emoji ?? null, color: t.color ?? null }]));
  const userMap = new Map(users.map((u) => [u._id.toString(), u.name as string]));
  const reasonMap = new Map(closeReasonsDocs.map((r) => [r._id.toString(), { label: r.label, color: r.color }]));

  // Overview totals are derived by summing the by-team maps — same underlying
  // data as the "Por Equipe" table, so the KPI cards and the table can never
  // silently disagree.
  const sum = (m: Map<string, number>) => Array.from(m.values()).reduce((s, n) => s + n, 0);
  const totalCreated = sum(createdByTeam);
  const openNow = sum(openByTeam);
  const resolvedInRange = sum(resolvedByTeam);
  const blocked = sum(blockedByTeam);

  const byTeam: ReportRow[] = mergeKeys(createdByTeam, resolvedByTeam, openByTeam, blockedByTeam)
    .map((key) => {
      const info = key === NONE_KEY ? null : teamMap.get(key);
      const total = createdByTeam.get(key) ?? 0;
      const resolved = resolvedByTeam.get(key) ?? 0;
      return {
        id: key === NONE_KEY ? null : key,
        name: key === NONE_KEY ? 'Sem equipe' : (info?.name ?? 'Equipe removida'),
        emoji: info?.emoji ?? null,
        color: info?.color ?? null,
        total, resolved,
        open: openByTeam.get(key) ?? 0,
        blocked: blockedByTeam.get(key) ?? 0,
        resolutionRate: pct(resolved, total),
      };
    })
    .sort((a, b) => b.total - a.total);

  const byAgent: ReportRow[] = mergeKeys(createdByAgent, resolvedByAgent, openByAgent, blockedByAgent)
    .map((key) => {
      const name = key === NONE_KEY ? 'Não atribuído' : (userMap.get(key) ?? 'Atendente removido');
      const total = createdByAgent.get(key) ?? 0;
      const resolved = resolvedByAgent.get(key) ?? 0;
      return {
        id: key === NONE_KEY ? null : key,
        name,
        total, resolved,
        open: openByAgent.get(key) ?? 0,
        blocked: blockedByAgent.get(key) ?? 0,
        resolutionRate: pct(resolved, total),
      };
    })
    .sort((a, b) => b.total - a.total);

  // Close reasons: total per reason + cross-tab by team/agent, built from the
  // same composite-key aggregations so nested breakdowns can't drift from the total.
  const reasonTotal = new Map<string, number>();
  const reasonByTeam = new Map<string, Map<string, number>>();
  for (const r of closeReasonByTeamRows) {
    const reasonKey = r._id.reason ? r._id.reason.toString() : NONE_KEY;
    const teamKey = r._id.team ? r._id.team.toString() : NONE_KEY;
    reasonTotal.set(reasonKey, (reasonTotal.get(reasonKey) ?? 0) + r.count);
    if (!reasonByTeam.has(reasonKey)) reasonByTeam.set(reasonKey, new Map());
    reasonByTeam.get(reasonKey)!.set(teamKey, r.count);
  }
  const reasonByAgent = new Map<string, Map<string, number>>();
  for (const r of closeReasonByAgentRows) {
    const reasonKey = r._id.reason ? r._id.reason.toString() : NONE_KEY;
    const agentKey = r._id.agent ? r._id.agent.toString() : NONE_KEY;
    if (!reasonByAgent.has(reasonKey)) reasonByAgent.set(reasonKey, new Map());
    reasonByAgent.get(reasonKey)!.set(agentKey, r.count);
  }

  const closeReasons: CloseReasonRow[] = Array.from(reasonTotal.keys())
    .map((key) => {
      const info = key === NONE_KEY ? null : reasonMap.get(key);
      const teamBreakdown = reasonByTeam.get(key) ?? new Map();
      const agentBreakdown = reasonByAgent.get(key) ?? new Map();
      return {
        id: key === NONE_KEY ? null : key,
        label: key === NONE_KEY ? 'Sem motivo' : (info?.label ?? 'Motivo removido'),
        color: info?.color ?? '#64748B',
        total: reasonTotal.get(key) ?? 0,
        byTeam: Array.from(teamBreakdown.entries()).map(([tk, count]) => ({
          id: tk === NONE_KEY ? null : tk,
          name: tk === NONE_KEY ? 'Sem equipe' : (teamMap.get(tk)?.name ?? 'Equipe removida'),
          count,
        })).sort((a, b) => b.count - a.count),
        byAgent: Array.from(agentBreakdown.entries()).map(([ak, count]) => ({
          id: ak === NONE_KEY ? null : ak,
          name: ak === NONE_KEY ? 'Não atribuído' : (userMap.get(ak) ?? 'Atendente removido'),
          count,
        })).sort((a, b) => b.count - a.count),
      };
    })
    .sort((a, b) => b.total - a.total);

  // Daily trend — fill every calendar day in range so gaps show as 0, not a missing point.
  const trendBuckets = emptyDailyBuckets(from, to, ['created', 'resolved']);
  for (const r of trendCreatedRows) { const b = trendBuckets[r._id]; if (b) b.created = r.count; }
  for (const r of trendResolvedRows) { const b = trendBuckets[r._id]; if (b) b.resolved = r.count; }
  const trend = Object.values(trendBuckets);

  const attendanceMode = { bot: 0, human: 0, idle: 0 };
  for (const r of attendanceModeRows) if (r._id && r._id in attendanceMode) attendanceMode[r._id as keyof typeof attendanceMode] = r.count;

  const slaRow = slaRows[0] ?? { total: 0, firstResponseBreached: 0, resolutionBreached: 0 };
  const avgFirstResponseMinutes = firstResponseRows[0]?.avgMinutes != null ? Math.round(firstResponseRows[0].avgMinutes) : null;

  const resolutionRate = pct(resolvedInRange, totalCreated);
  const prevResolutionRate = pct(prevOverview.resolvedInRange, prevOverview.totalCreated);

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    overview: {
      totalCreated, openNow, resolvedInRange, blocked, resolutionRate,
      avgFirstResponseMinutes,
      slaFirstResponseBreachRate: pct(slaRow.firstResponseBreached, slaRow.total),
      slaResolutionBreachRate: pct(slaRow.resolutionBreached, slaRow.total),
    },
    deltas: {
      totalCreated: delta(totalCreated, prevOverview.totalCreated),
      resolvedInRange: delta(resolvedInRange, prevOverview.resolvedInRange),
      blocked: delta(blocked, prevOverview.blocked),
      resolutionRate: delta(resolutionRate, prevResolutionRate),
    },
    trend,
    attendanceMode,
    byTeam,
    byAgent,
    closeReasons,
  };
}

/** Raw per-conversation rows for the export's detailed sheet — same filters,
 *  no pagination (this is a full-fidelity audit dump, not a paged list). */
export async function findReportConversations(filters: ReportFilters) {
  const { workspaceId, from, to, teamGroupId, agentId } = filters;
  const wsOid = new Types.ObjectId(workspaceId);
  const match: Record<string, unknown> = { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } };
  if (teamGroupId && Types.ObjectId.isValid(teamGroupId)) match.teamGroupId = new Types.ObjectId(teamGroupId);
  if (agentId && Types.ObjectId.isValid(agentId)) match.assignedAgentId = new Types.ObjectId(agentId);

  const [conversations, teamGroups, users, closeReasonsDocs] = await Promise.all([
    Conversation.find(match)
      .select('name phone status teamGroupId assignedAgentId tags contactId closeReasonId createdAt resolvedAt')
      .populate('contactId', 'status')
      .lean(),
    TeamGroup.find({ workspaceId: wsOid }).select('name').lean(),
    User.find({ workspaceId: wsOid }).select('name').lean(),
    CloseReason.find({ workspaceId: wsOid }).select('label').lean(),
  ]);

  const teamMap = new Map(teamGroups.map((t) => [t._id.toString(), t.name]));
  const userMap = new Map(users.map((u) => [u._id.toString(), u.name as string]));
  const reasonMap = new Map(closeReasonsDocs.map((r) => [r._id.toString(), r.label]));

  return conversations.map((c) => ({
    name: c.name,
    phone: c.phone ?? '',
    status: c.status,
    team: c.teamGroupId ? (teamMap.get(c.teamGroupId.toString()) ?? 'Equipe removida') : 'Sem equipe',
    agent: c.assignedAgentId ? (userMap.get(c.assignedAgentId.toString()) ?? 'Atendente removido') : 'Não atribuído',
    tags: (c.tags ?? []).join(', '),
    blocked: (c.contactId as unknown as { status?: string } | null)?.status === 'blocked',
    closeReason: c.closeReasonId ? (reasonMap.get(c.closeReasonId.toString()) ?? 'Motivo removido') : (c.status === 'resolved' ? 'Sem motivo' : ''),
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt ?? null,
  }));
}
