import pino from 'pino';
import { Workspace } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import { deleteWorkspaceCascade } from './workspace-deletion.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 6 * 60 * 60_000; // every 6 hours — this is a 30-day grace period, no need to poll fast
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Global workspace-deletion sweep — ticks every few hours, permanently deleting any
 * workspace whose `deletionScheduledFor` (set by the owner via delete-request, see
 * workspaces.routes.ts) has passed. Mirrors the setInterval + persisted-state shape of
 * campaign-dispatcher.ts/sla-scheduler.ts.
 */
export function startWorkspaceDeletionScheduler(sessionManager: SessionManager): void {
  if (timer) return;
  timer = setInterval(() => { tick(sessionManager).catch((err) => logger.error({ err }, '[workspace-deletion] scheduler tick failed')); }, TICK_MS);
  logger.info('[workspace-deletion] scheduler started');
}

export function stopWorkspaceDeletionScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(sessionManager: SessionManager): Promise<void> {
  const due = await Workspace.find({ deletionScheduledFor: { $lte: new Date() } }).select('_id name').lean();
  for (const ws of due) {
    try {
      logger.warn({ workspaceId: ws._id, name: ws.name }, '[workspace-deletion] grace period expired — deleting permanently');
      await deleteWorkspaceCascade(sessionManager, ws._id.toString());
    } catch (err) {
      logger.error({ err, workspaceId: ws._id }, '[workspace-deletion] cascade failed — will retry next tick');
    }
  }
}
