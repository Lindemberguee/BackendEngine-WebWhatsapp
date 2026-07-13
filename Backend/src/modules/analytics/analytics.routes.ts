import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Conversation, Message, Contact, Flow, FlowRun, Lead, Campaign } from '../../db/models';
import { User } from '../../db/models/User.model';

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function daysBetween(a: Date, b: Date) {
  return Math.ceil((b.getTime() - a.getTime()) / 86_400_000);
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Build an array of {date, key: 0} for every calendar day in [from, to] */
function emptyDailyBuckets<T extends string>(
  from: Date, to: Date, keys: T[]
): Record<string, number & { date: string } & Record<T, number>> {
  const map: Record<string, Record<string, number>> = {};
  let cur = startOfDay(from);
  const end = startOfDay(to);
  while (cur <= end) {
    const k = isoDate(cur);
    map[k] = { date: k as unknown as number, ...Object.fromEntries(keys.map((key) => [key, 0])) };
    cur = addDays(cur, 1);
  }
  return map as ReturnType<typeof emptyDailyBuckets<T>>;
}

function delta(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function analyticsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  /**
   * GET /api/analytics/overview
   * Query params: from (ISO date), to (ISO date), period ("7d"|"30d"|"today")
   */
  fastify.get('/overview', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const wsOid = new Types.ObjectId(workspaceId);

    const q = request.query as Record<string, string>;

    // Resolve period
    const now = new Date();
    let from: Date;
    let to: Date = now;
    if (q.from && q.to) {
      from = new Date(q.from);
      to   = new Date(q.to);
    } else if (q.period === 'today') {
      from = startOfDay(now);
    } else if (q.period === '30d') {
      from = addDays(now, -30);
    } else {
      // default: 7d
      from = addDays(now, -7);
    }

    const span = Math.max(1, daysBetween(from, to));
    const prevFrom = addDays(from, -span);
    const prevTo   = from;

    // ── Run all aggregations in parallel ─────────────────────────────────────

    const [
      // Conversations
      convStatusAgg,
      convTrendAgg,
      convModesAgg,
      prevConvTotal,

      // Messages
      msgTotalAgg,
      msgTrendAgg,
      prevMsgTotal,

      // Contacts
      contactTotal,
      contactNewAgg,
      contactTrendAgg,
      contactBlocked,
      prevContactNew,

      // Leads
      leadStatusAgg,
      leadTrendAgg,
      prevLeadTotal,

      // Flows
      flowRunsAgg,
      activeFlows,

      // Team
      agents,
      convPerAgentAgg,

      // Campaigns
      campaignsActive,
      campaignStatsAgg,
    ] = await Promise.all([
      // conv by status (current period created OR still open)
      Conversation.aggregate([
        { $match: { workspaceId: wsOid } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      // conv trend daily (new conversations)
      Conversation.aggregate([
        { $match: { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'America/Sao_Paulo' } }, total: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // attendance mode distribution
      Conversation.aggregate([
        { $match: { workspaceId: wsOid } },
        { $group: { _id: '$attendanceMode', count: { $sum: 1 } } },
      ]),

      // previous period conversations
      Conversation.countDocuments({ workspaceId: wsOid, createdAt: { $gte: prevFrom, $lt: prevTo } }),

      // messages total (current period)
      Message.aggregate([
        { $match: { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            sent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
            received: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          },
        },
      ]),

      // messages trend daily
      Message.aggregate([
        { $match: { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'America/Sao_Paulo' } },
            sent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
            received: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // prev period messages
      Message.countDocuments({ workspaceId: wsOid, createdAt: { $gte: prevFrom, $lt: prevTo } }),

      // contacts total
      Contact.countDocuments({ workspaceId: wsOid }),

      // new contacts in period
      Contact.countDocuments({ workspaceId: wsOid, createdAt: { $gte: from, $lte: to } }),

      // contacts trend
      Contact.aggregate([
        { $match: { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'America/Sao_Paulo' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // contacts blocked
      Contact.countDocuments({ workspaceId: wsOid, status: 'blocked' }),

      // prev contacts new
      Contact.countDocuments({ workspaceId: wsOid, createdAt: { $gte: prevFrom, $lt: prevTo } }),

      // leads by status + value
      Lead.aggregate([
        { $match: { workspaceId: wsOid } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalValue: { $sum: '$value' },
          },
        },
      ]),

      // leads trend
      Lead.aggregate([
        { $match: { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'America/Sao_Paulo' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),

      // prev leads
      Lead.countDocuments({ workspaceId: wsOid, createdAt: { $gte: prevFrom, $lt: prevTo } }),

      // flow runs in period
      FlowRun.aggregate([
        { $match: { workspaceId: wsOid, createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),

      // active (enabled) flows
      Flow.countDocuments({ workspaceId: wsOid, enabled: true }),

      // agents
      User.find({ workspaceId, role: { $in: ['agent', 'admin', 'owner'] } }, { name: 1, role: 1 }).lean(),

      // conversations per agent (current period)
      Conversation.aggregate([
        {
          $match: {
            workspaceId: wsOid,
            assignedAgentId: { $ne: null, $exists: true },
            updatedAt: { $gte: from, $lte: to },
          },
        },
        { $group: { _id: '$assignedAgentId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // campaigns currently sending/scheduled
      Campaign.countDocuments({ workspaceId: wsOid, status: { $in: ['sending', 'scheduled'] } }),

      // aggregate stats across campaigns started in period
      Campaign.aggregate([
        { $match: { workspaceId: wsOid, startedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            campaigns: { $sum: 1 },
            sent: { $sum: '$stats.sent' },
            delivered: { $sum: '$stats.delivered' },
            read: { $sum: '$stats.read' },
            replied: { $sum: '$stats.replied' },
            failed: { $sum: '$stats.failed' },
          },
        },
      ]),
    ]);

    // ── Shape results ─────────────────────────────────────────────────────────

    // Conversations by status
    const convByStatus: Record<string, number> = { open: 0, pending: 0, resolved: 0, snoozed: 0 };
    for (const r of convStatusAgg) if (r._id) convByStatus[r._id] = r.count;
    const convTotal = Object.values(convByStatus).reduce((s, n) => s + n, 0);
    const convNewInPeriod = convTrendAgg.reduce((s: number, r: { total: number }) => s + r.total, 0);

    // Conv trend (daily, fill gaps)
    const convBuckets = emptyDailyBuckets(from, to, ['total']);
    for (const r of convTrendAgg) {
      const b = convBuckets[r._id as string];
      if (b) b.total = r.total;
    }
    const convTrend = Object.values(convBuckets);

    // Attendance mode
    const modeMap: Record<string, number> = { bot: 0, human: 0, idle: 0 };
    for (const r of convModesAgg) if (r._id) modeMap[r._id] = r.count;

    // Messages
    const msgRow = msgTotalAgg[0] ?? { total: 0, sent: 0, received: 0 };
    const msgBuckets = emptyDailyBuckets(from, to, ['sent', 'received']);
    for (const r of msgTrendAgg) {
      const b = msgBuckets[r._id as string];
      if (b) { b.sent = r.sent; b.received = r.received; }
    }
    const msgTrend = Object.values(msgBuckets);

    // Contacts trend
    const ctBuckets = emptyDailyBuckets(from, to, ['count']);
    for (const r of contactTrendAgg) {
      const b = ctBuckets[r._id as string];
      if (b) b.count = r.count;
    }
    const contactTrend = Object.values(ctBuckets);

    // Leads
    const leadMap: Record<string, { count: number; totalValue: number }> = { open: { count: 0, totalValue: 0 }, won: { count: 0, totalValue: 0 }, lost: { count: 0, totalValue: 0 } };
    for (const r of leadStatusAgg) if (r._id) leadMap[r._id] = { count: r.count, totalValue: r.totalValue };
    const leadTotal = Object.values(leadMap).reduce((s, r) => s + r.count, 0);
    const leadNewInPeriod = leadTrendAgg.reduce((s: number, r: { count: number }) => s + r.count, 0);
    const leadWonValue = leadMap.won.totalValue;
    const leadPipelineValue = leadMap.open.totalValue;
    const conversionRate = leadTotal > 0 ? Math.round((leadMap.won.count / leadTotal) * 100) : 0;

    // Lead trend
    const ldBuckets = emptyDailyBuckets(from, to, ['count']);
    for (const r of leadTrendAgg) {
      const b = ldBuckets[r._id as string];
      if (b) b.count = r.count;
    }
    const leadTrend = Object.values(ldBuckets);

    // Flow runs
    const flowRunMap: Record<string, number> = { completed: 0, cancelled: 0, running: 0, waiting: 0, failed: 0 };
    for (const r of flowRunsAgg) if (r._id) flowRunMap[r._id] = r.count;
    const totalRuns = Object.values(flowRunMap).reduce((s, n) => s + n, 0);
    const completionRate = totalRuns > 0 ? Math.round((flowRunMap.completed / totalRuns) * 100) : 0;

    // Team / agent performance
    const agentIdToName = new Map(agents.map((a) => [a._id.toString(), a.name as string]));
    const agentPerformance = convPerAgentAgg.map((r) => ({
      agentId: r._id.toString(),
      name: agentIdToName.get(r._id.toString()) ?? 'Agente',
      conversations: r.count,
    }));

    // Campaigns
    const campaignRow = campaignStatsAgg[0] ?? { campaigns: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 };
    const campaignReplyRate = campaignRow.sent > 0 ? Math.round((campaignRow.replied / campaignRow.sent) * 100) : 0;

    // Deltas (% vs previous period)
    const deltas = {
      conversations: delta(convNewInPeriod, prevConvTotal),
      messages: delta(msgRow.total, prevMsgTotal),
      contacts: delta(contactNewAgg, prevContactNew),
      leads: delta(leadNewInPeriod, prevLeadTotal),
    };

    return reply.send({
      data: {
        period: { from: from.toISOString(), to: to.toISOString(), span },

        conversations: {
          total: convTotal,
          newInPeriod: convNewInPeriod,
          byStatus: convByStatus,
          trend: convTrend,
          attendanceMode: modeMap,
        },

        messages: {
          total: msgRow.total,
          sent: msgRow.sent,
          received: msgRow.received,
          trend: msgTrend,
        },

        contacts: {
          total: contactTotal,
          newInPeriod: contactNewAgg,
          blocked: contactBlocked,
          trend: contactTrend,
        },

        leads: {
          total: leadTotal,
          newInPeriod: leadNewInPeriod,
          byStatus: { open: leadMap.open.count, won: leadMap.won.count, lost: leadMap.lost.count },
          pipelineValue: leadPipelineValue,
          wonValue: leadWonValue,
          conversionRate,
          trend: leadTrend,
        },

        flows: {
          activeFlows,
          totalRuns,
          completed: flowRunMap.completed,
          cancelled: flowRunMap.cancelled,
          completionRate,
        },

        team: {
          totalAgents: agents.length,
          agentPerformance,
        },

        campaigns: {
          active: campaignsActive,
          launchedInPeriod: campaignRow.campaigns,
          sent: campaignRow.sent,
          delivered: campaignRow.delivered,
          read: campaignRow.read,
          replied: campaignRow.replied,
          failed: campaignRow.failed,
          replyRate: campaignReplyRate,
        },

        deltas,
      },
    });
  });

  /**
   * GET /api/analytics/realtime
   * Snapshot of live counters — refreshed every 30s on the frontend.
   */
  fastify.get('/realtime', auth, async (request, reply) => {
    const { workspaceId } = request.user as { workspaceId: string };
    const wsOid = new Types.ObjectId(workspaceId);
    const todayStart = startOfDay(new Date());

    const [openConvs, pendingConvs, todayMessages, activeRuns, botConvs, humanConvs] = await Promise.all([
      Conversation.countDocuments({ workspaceId: wsOid, status: 'open' }),
      Conversation.countDocuments({ workspaceId: wsOid, status: 'pending' }),
      Message.countDocuments({ workspaceId: wsOid, createdAt: { $gte: todayStart } }),
      FlowRun.countDocuments({ workspaceId: wsOid, status: { $in: ['running', 'waiting'] } }),
      Conversation.countDocuments({ workspaceId: wsOid, attendanceMode: 'bot' }),
      Conversation.countDocuments({ workspaceId: wsOid, attendanceMode: 'human' }),
    ]);

    return reply.send({
      data: { openConvs, pendingConvs, todayMessages, activeRuns, botConvs, humanConvs, updatedAt: new Date().toISOString() },
    });
  });
}
