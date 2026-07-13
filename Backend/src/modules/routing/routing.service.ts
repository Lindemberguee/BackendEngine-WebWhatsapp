import { Types } from 'mongoose';
import pino from 'pino';
import { Conversation, TeamGroup, User, Workspace } from '../../db/models';
import type { IBusinessHours, RoutingStrategy } from '../../db/models';
import type { WebSocketGateway } from '../../ws/gateway';
import { notify } from '../notifications/notification.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export type AutoRouteMode = 'on_human' | 'on_new' | 'off';

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Reads Workspace.settings.autoRoute — defaults to 'on_human' (route only once a flow/agent hands off to a person, never while the bot is still handling it). */
export async function getAutoRouteMode(workspaceId: string): Promise<AutoRouteMode> {
  const ws = await Workspace.findById(workspaceId).select('settings').lean();
  const mode = (ws?.settings as Record<string, unknown> | undefined)?.autoRoute;
  return mode === 'on_new' || mode === 'off' ? mode : 'on_human';
}

/** Live count of open/pending conversations currently assigned to an agent — not persisted, computed on demand. */
async function liveLoad(workspaceId: string, agentId: Types.ObjectId): Promise<number> {
  return Conversation.countDocuments({ workspaceId, assignedAgentId: agentId, status: { $in: ['open', 'pending'] } });
}

/** Queue-level business hours win; falls back to the workspace default; absent config means always-on. */
export function resolveBusinessHours(
  team: { businessHours?: IBusinessHours } | null | undefined,
  workspace: { settings?: Record<string, unknown> } | null | undefined
): IBusinessHours | null {
  if (team?.businessHours?.schedule?.length) return team.businessHours;
  const fallback = workspace?.settings?.defaultBusinessHours as IBusinessHours | undefined;
  return fallback?.schedule?.length ? fallback : null;
}

export function isWithinBusinessHours(config: IBusinessHours | null | undefined, now = new Date()): boolean {
  if (!config?.schedule?.length) return true; // no config configured = always open

  const tz = config.timezone || 'America/Sao_Paulo';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAY_MAP[get('weekday')];
  const hour = get('hour') === '24' ? '00' : get('hour').padStart(2, '0'); // some ICU impls emit '24' for midnight
  const nowHm = `${hour}:${get('minute').padStart(2, '0')}`;

  const day = config.schedule.find((d) => d.weekday === weekday);
  if (!day || !day.enabled) return false;
  return nowHm >= day.start && nowHm <= day.end;
}

/**
 * Picks the best eligible agent for a conversation: members of the given queue
 * (or every agent/admin/owner in the workspace when there's no queue), filtered
 * to those marked 'available' and under their own concurrency cap, ranked by
 * the queue's routing strategy. Returns null when nobody's eligible (business
 * hours closed, strategy is 'manual', or every candidate is at capacity) —
 * callers should leave the conversation in the unassigned queue in that case.
 */
export async function pickAgent(workspaceId: string, teamGroupId?: string | null): Promise<Types.ObjectId | null> {
  const team = teamGroupId && Types.ObjectId.isValid(teamGroupId)
    ? await TeamGroup.findOne({ _id: teamGroupId, workspaceId })
    : null;

  const strategy: RoutingStrategy = team?.routingStrategy ?? 'least_busy';
  if (strategy === 'manual') return null;

  const workspace = await Workspace.findById(workspaceId).select('settings').lean();
  const hours = resolveBusinessHours(team, workspace);
  if (!isWithinBusinessHours(hours)) return null;

  const candidateFilter: Record<string, unknown> = team
    ? { _id: { $in: team.memberIds }, isActive: true, availability: 'available' }
    : { workspaceId, isActive: true, availability: 'available', role: { $in: ['agent', 'admin', 'owner'] } };

  const candidates = await User.find(candidateFilter).select('_id maxConcurrentChats').lean();
  if (!candidates.length) return null;

  const withLoad = await Promise.all(
    candidates.map(async (u) => ({
      id: u._id as Types.ObjectId,
      max: u.maxConcurrentChats ?? 0,
      load: await liveLoad(workspaceId, u._id as Types.ObjectId),
    }))
  );
  const eligible = withLoad.filter((c) => c.max === 0 || c.load < c.max);
  if (!eligible.length) return null;

  if (strategy === 'round_robin' && team) {
    const idx = (team.roundRobinCursor ?? 0) % eligible.length;
    await TeamGroup.updateOne({ _id: team._id }, { $set: { roundRobinCursor: (idx + 1) % eligible.length } });
    return eligible[idx].id;
  }

  // least_busy (default; also the strategy used for workspace-wide routing with no queue)
  eligible.sort((a, b) => a.load - b.load);
  return eligible[0].id;
}

/**
 * Auto-assigns an unassigned conversation to the best eligible agent and
 * notifies them. No-ops (leaves the conversation in the queue) when already
 * assigned, when nobody's eligible, or outside business hours. Never throws —
 * a routing failure must not break the flow/handoff that triggered it.
 */
export async function routeConversation(conversationId: string, gateway?: WebSocketGateway): Promise<void> {
  try {
    const conv = await Conversation.findById(conversationId).select('workspaceId assignedAgentId teamGroupId name phone');
    if (!conv || conv.assignedAgentId) return; // idempotent — don't reassign an already-owned ticket

    const agentId = await pickAgent(conv.workspaceId.toString(), conv.teamGroupId?.toString());
    if (!agentId) return; // stays in the queue

    // Atomic guard: only claim the ticket if it's still unassigned (a manual assign or a
    // concurrent routing pass may have grabbed it first).
    const updated = await Conversation.findOneAndUpdate(
      { _id: conv._id, $or: [{ assignedAgentId: null }, { assignedAgentId: { $exists: false } }] },
      { $set: { assignedAgentId: agentId, routedAt: new Date() } },
      { new: true }
    );
    if (!updated) return;

    if (gateway) {
      const agent = await User.findById(agentId).select('name avatarUrl').lean();
      // Matches the { conversationId, assignee } contract the frontend already listens
      // for from the manual /assign route (see conversations.routes.ts).
      gateway.broadcastToWorkspace(conv.workspaceId.toString(), 'conversation:assigned', {
        conversationId: conv._id.toString(),
        assignee: agent ? { id: agentId.toString(), name: agent.name, avatarUrl: agent.avatarUrl } : { id: agentId.toString() },
      });
      void notify(gateway, {
        workspaceId: conv.workspaceId.toString(), recipientId: agentId.toString(),
        type: 'conversation.assigned', title: 'Nova conversa atribuída a você',
        message: `${updated.name || updated.phone || 'Um contato'} — atribuída automaticamente pela fila`,
        link: '/conversations', metadata: { conversationId: conv._id.toString() },
      });
    }
  } catch (err) {
    logger.warn({ err, conversationId }, '[routing] routeConversation failed');
  }
}
