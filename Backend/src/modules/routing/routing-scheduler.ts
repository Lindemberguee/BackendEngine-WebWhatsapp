import type { Types } from 'mongoose';
import { Conversation } from '../../db/models';
import type { WebSocketGateway } from '../../ws/gateway';
import { getAutoRouteMode, routeConversation } from './routing.service';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 60_000; // matches sla-scheduler's cadence — a minute is plenty for re-queuing.
const BATCH_PER_WORKSPACE = 50; // bound work per tick so one huge workspace can't starve the others.
let timer: ReturnType<typeof setInterval> | null = null;
// Re-entrancy guard — routing every workspace's queue serially can outlast a
// 60s tick at scale; without this an overlapping tick could route the same
// conversation twice.
let running = false;

/**
 * Retries auto-routing for conversations stuck unassigned in a queue. Without
 * this, `routeConversation` (routing.service.ts) only ever runs at the moment
 * a ticket enters the queue (new message, human handoff, flow block) — if
 * nobody was eligible right then (outside business hours, everyone at
 * capacity), the ticket sits there forever with no retry until some other
 * unrelated event happens to touch that conversation again. This ticks every
 * minute and re-attempts routing for every still-unassigned open/pending
 * conversation, so a ticket gets picked up the moment an agent frees up or a
 * business-hours window opens — not just when a customer happens to text again.
 */
export function startRoutingScheduler(gateway: WebSocketGateway): void {
  if (timer) return;
  timer = setInterval(() => { tick(gateway).catch((err) => logger.error({ err }, '[routing] scheduler tick failed')); }, TICK_MS);
  logger.info('[routing] scheduler started');
}

export function stopRoutingScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(gateway: WebSocketGateway): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runTick(gateway);
  } finally {
    running = false;
  }
}

async function runTick(gateway: WebSocketGateway): Promise<void> {
  const queuedFilter = {
    $or: [{ assignedAgentId: null }, { assignedAgentId: { $exists: false } }],
    status: { $in: ['open', 'pending'] },
  };

  const workspaceIds: Types.ObjectId[] = await Conversation.distinct('workspaceId', queuedFilter);

  for (const workspaceId of workspaceIds) {
    try {
      // A workspace on 'off' means manual assignment is intentional — don't
      // second-guess that by auto-routing behind the scenes.
      const mode = await getAutoRouteMode(workspaceId.toString());
      if (mode === 'off') continue;

      const queued = await Conversation.find({ ...queuedFilter, workspaceId })
        .select('_id')
        .sort({ createdAt: 1 }) // oldest-waiting first — fairness, not last-in-first-served
        .limit(BATCH_PER_WORKSPACE)
        .lean();

      for (const conv of queued) {
        await routeConversation(conv._id.toString(), gateway);
      }
    } catch (err) {
      logger.warn({ err, workspaceId }, '[routing] failed to re-queue workspace');
    }
  }
}
