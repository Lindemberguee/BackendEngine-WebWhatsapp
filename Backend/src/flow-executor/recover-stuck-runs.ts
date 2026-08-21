import pino from 'pino';
import { FlowRun } from '../db/models';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Called once at boot. A FlowRun with status='running' represents a node actively
 * being processed inside FlowRunner.advanceLocked's synchronous loop — that only
 * happens in-memory, so if the process is just starting up, every run still marked
 * 'running' from before is provably orphaned (the process that was executing it is
 * gone). Left alone, these blocked the conversation from ever triggering a fresh
 * flow again (handleInboundForFlows treats a 'running' run as "already active").
 * 'waiting' and 'delayed' runs are untouched — those are durable, expected states
 * (waiting for a reply, or for flow-run-scheduler.ts to pick up a delay) and aren't
 * stuck just because the process restarted.
 */
export async function recoverStuckFlowRuns(): Promise<void> {
  const res = await FlowRun.updateMany(
    { status: 'running' },
    { $set: { status: 'failed', failureReason: 'Execução interrompida por reinício do servidor' } }
  );
  if (res.modifiedCount) {
    logger.warn({ count: res.modifiedCount }, '[flow] recovered orphaned running runs from a previous process on boot');
  }
}
