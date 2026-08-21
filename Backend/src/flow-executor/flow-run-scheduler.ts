import pino from 'pino';
import { FlowRun } from '../db/models';
import type { SessionManager } from '../session-manager/SessionManager';
import { dispatchScheduledEventFlows } from './scheduled-event-trigger';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 15_000; // delay/timeout precision doesn't need to be tighter than this.
const BATCH_PER_SWEEP = 100;

let timer: ReturnType<typeof setInterval> | null = null;
// Mirrors the other schedulers' guard — prevents an overlapping tick (e.g. a slow
// sweep of many due runs) from re-picking-up the same runs a second time before
// the first pass's atomic claims (FlowRunner.continueDelayed/continueTimedOut) land.
let running = false;

/**
 * Authoritative resumption for two kinds of parked FlowRun: `delayed` (an
 * automation.delay block waiting out its duration) and `waiting` past its
 * wait_response timeout. Both are *also* attempted via an in-process setTimeout at
 * the point they're scheduled (see runner.ts) for a snappy feel on short waits, but
 * that timer is lost on every process restart and silently fires early/never for
 * very long durations (Node's setTimeout overflows past ~24.8 days). This sweep is
 * what actually guarantees a delay of any length — including "wait 3 days" — fires,
 * and that a mid-delay restart doesn't orphan the run forever.
 */
export function startFlowRunScheduler(sessionManager: SessionManager): void {
  if (timer) return;
  timer = setInterval(() => { tick(sessionManager).catch((err) => logger.error({ err }, '[flow-run-scheduler] tick failed')); }, TICK_MS);
  logger.info('[flow-run-scheduler] started');
}

export function stopFlowRunScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick(sessionManager: SessionManager): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runTick(sessionManager);
  } finally {
    running = false;
  }
}

async function runTick(sessionManager: SessionManager): Promise<void> {
  const now = new Date();

  const delayed = await FlowRun.find({ status: 'delayed', resumeAt: { $lte: now } })
    .select('_id instanceId').limit(BATCH_PER_SWEEP).lean();
  for (const run of delayed) {
    try {
      const session = sessionManager.getSession(run.instanceId.toString());
      // Instance not connected right now — leave it 'delayed'; the next tick
      // (once it's back) or a later sweep will pick it up. Not an error.
      if (!session) continue;
      await session.continueDelayedFlowRun(run._id.toString());
    } catch (err) {
      logger.warn({ err, runId: run._id }, '[flow-run-scheduler] failed to resume delayed run');
    }
  }

  const timedOut = await FlowRun.find({ status: 'waiting', 'waiting.waitingUntil': { $lte: now } })
    .select('_id instanceId').limit(BATCH_PER_SWEEP).lean();
  for (const run of timedOut) {
    try {
      const session = sessionManager.getSession(run.instanceId.toString());
      if (!session) continue;
      await session.continueTimedOutFlowRun(run._id.toString());
    } catch (err) {
      logger.warn({ err, runId: run._id }, '[flow-run-scheduler] failed to time out run');
    }
  }

  try {
    await dispatchScheduledEventFlows(sessionManager, now);
  } catch (err) {
    logger.error({ err }, '[flow-run-scheduler] scheduled-event dispatch failed');
  }
}
