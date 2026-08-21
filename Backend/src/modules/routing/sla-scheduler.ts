import type { Types } from 'mongoose';
import { Conversation, TeamGroup, Workspace } from '../../db/models';
import type { WebSocketGateway } from '../../ws/gateway';
import { notify, notifyMany } from '../notifications/notification.service';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const TICK_MS = 60_000; // SLA breaches don't need second-level precision — a minute is plenty.
const BATCH_PER_WORKSPACE = 100; // bound work per tick so one huge workspace can't starve the others.
let timer: ReturnType<typeof setInterval> | null = null;
// Re-entrancy guard — mirrors the other schedulers; prevents an overlapping
// tick from re-flagging/re-notifying the same breach twice.
let running = false;

/**
 * Global SLA-breach scanner — ticks every minute, flagging any conversation whose
 * first-response or resolution deadline has passed and hasn't been met yet. Mirrors
 * the campaign-dispatcher's setInterval + persisted-state shape (see
 * campaigns/campaign-dispatcher.ts) so it survives restarts without re-alerting
 * anything already marked breached.
 */
export function startSlaScheduler(gateway: WebSocketGateway): void {
  if (timer) return;
  timer = setInterval(() => { tick(gateway).catch((err) => logger.error({ err }, '[sla] scheduler tick failed')); }, TICK_MS);
  logger.info('[sla] scheduler started');
}

export function stopSlaScheduler(): void {
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
  const now = new Date();

  // Scanning across all workspaces at once (no workspaceId in the filter) can't use
  // either of the workspaceId-prefixed compound indexes below — it fell back to a
  // full collection scan every 60s. Iterating per workspace lets each query use its
  // index, and BATCH_PER_WORKSPACE bounds how much one huge workspace can load.
  const workspaceIds: Types.ObjectId[] = await Conversation.distinct('workspaceId', {
    status: { $nin: ['resolved', 'closed'] },
    $or: [{ slaFirstResponseBreached: false }, { slaResolutionBreached: false }],
  });

  for (const workspaceId of workspaceIds) {
    try {
      const firstResponseDue = await Conversation.find({
        workspaceId,
        firstResponseDueAt: { $lte: now },
        firstRespondedAt: { $exists: false },
        slaFirstResponseBreached: false,
        status: { $nin: ['resolved', 'closed'] },
      }).select('workspaceId assignedAgentId teamGroupId name phone').limit(BATCH_PER_WORKSPACE);

      for (const conv of firstResponseDue) {
        await Conversation.updateOne({ _id: conv._id }, { $set: { slaFirstResponseBreached: true } });
        await alertBreach(gateway, conv.workspaceId.toString(), conv._id.toString(), conv.teamGroupId?.toString(), conv.assignedAgentId?.toString(),
          `${conv.name || conv.phone || 'Um contato'} — 1ª resposta atrasada`, 'sla.first_response_breached', 'first_response');
      }

      const resolutionDue = await Conversation.find({
        workspaceId,
        resolutionDueAt: { $lte: now },
        slaResolutionBreached: false,
        status: { $nin: ['resolved', 'closed'] },
      }).select('workspaceId assignedAgentId teamGroupId name phone').limit(BATCH_PER_WORKSPACE);

      for (const conv of resolutionDue) {
        await Conversation.updateOne({ _id: conv._id }, { $set: { slaResolutionBreached: true } });
        await alertBreach(gateway, conv.workspaceId.toString(), conv._id.toString(), conv.teamGroupId?.toString(), conv.assignedAgentId?.toString(),
          `${conv.name || conv.phone || 'Um contato'} — resolução atrasada`, 'sla.resolution_breached', 'resolution');
      }
    } catch (err) {
      logger.warn({ err, workspaceId }, '[sla] failed to scan workspace');
    }
  }
}

async function alertBreach(
  gateway: WebSocketGateway, workspaceId: string, conversationId: string,
  teamGroupId: string | undefined, assignedAgentId: string | undefined,
  message: string, notificationType: 'sla.first_response_breached' | 'sla.resolution_breached', kind: 'first_response' | 'resolution'
): Promise<void> {
  gateway.broadcastToConversationVisibility(workspaceId, assignedAgentId, 'sla:breach', { conversationId, kind });

  const recipientIds = new Set<string>();
  if (assignedAgentId) recipientIds.add(assignedAgentId);
  // Team lead also gets alerted so an unattended queue doesn't go unnoticed.
  try {
    if (teamGroupId) {
      const team = await TeamGroup.findById(teamGroupId).select('leadId').lean();
      if (team?.leadId) recipientIds.add(team.leadId.toString());
    }
    if (!recipientIds.size) {
      const ws = await Workspace.findById(workspaceId).select('ownerId').lean();
      if (ws?.ownerId) recipientIds.add(ws.ownerId.toString());
    }
  } catch { /* best-effort escalation */ }

  if (recipientIds.size === 1) {
    void notify(gateway, {
      workspaceId, recipientId: [...recipientIds][0], type: notificationType,
      title: 'SLA estourado', message, link: '/conversations', metadata: { conversationId },
    });
  } else if (recipientIds.size > 1) {
    void notifyMany(gateway, [...recipientIds], {
      workspaceId, type: notificationType,
      title: 'SLA estourado', message, link: '/conversations', metadata: { conversationId },
    });
  }
}
