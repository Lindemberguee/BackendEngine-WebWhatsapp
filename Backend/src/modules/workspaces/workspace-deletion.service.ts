import pino from 'pino';
import {
  Workspace, User, Instance, Conversation, Message, Contact, Label,
  Flow, FlowRun, FlowFolder, Pipeline, Lead, LeadActivity, TeamGroup,
  Campaign, CampaignRecipient, Subscription, Invoice,
  WebhookSubscription, WebhookDelivery, WebhookInboundLog, ApiKey, Avatar, AuditLog, Notification,
} from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import { deleteMedia } from '../../shared/media-storage';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const GRACE_PERIOD_DAYS = 30;

export function deletionDeadline(from = new Date()): Date {
  return new Date(from.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
}

/** Every model scoped by `workspaceId`, deleted in the cascade — order doesn't matter,
 *  nothing here has a foreign-key constraint that would block deletion. Typed as a plain
 *  deleteMany surface since each Model's overload set is otherwise too different to unify. */
const WORKSPACE_SCOPED_MODELS: Array<{ deleteMany(filter: Record<string, unknown>): Promise<unknown> }> = [
  Conversation, Message, Contact, Label, Flow, FlowRun, FlowFolder, Pipeline, Lead, LeadActivity,
  TeamGroup, Campaign, CampaignRecipient, Subscription, Invoice,
  WebhookSubscription, WebhookDelivery, WebhookInboundLog, ApiKey, AuditLog, Notification,
];

/**
 * Permanently deletes a workspace and every piece of data scoped to it — the
 * execution side of the LGPD deletion-request flow (see workspace-deletion-scheduler.ts,
 * which calls this once `deletionScheduledFor` has passed). Never partially applies:
 * WhatsApp sessions are logged out first (their auth creds live on the Instance doc
 * itself), then every scoped collection is purged, user avatars and accounts last,
 * and finally the Workspace document.
 */
export async function deleteWorkspaceCascade(sessionManager: SessionManager, workspaceId: string): Promise<void> {
  const archivedMedia = Message.find({ workspaceId, 'mediaStorage.key': { $exists: true } }).select('mediaStorage').lean().cursor();
  for await (const message of archivedMedia) {
    if (message.mediaStorage?.key) {
      await deleteMedia(message.mediaStorage.key, message.mediaStorage.provider).catch((err) =>
        logger.warn({ err, key: message.mediaStorage?.key }, '[workspace-deletion] failed to delete archived media')
      );
    }
  }
  const instances = await Instance.find({ workspaceId }).select('_id').lean();
  for (const inst of instances) {
    try {
      await sessionManager.logoutSession(inst._id.toString());
    } catch (err) {
      logger.warn({ err, instanceId: inst._id }, '[workspace-deletion] failed to log out session, continuing anyway');
    }
  }
  await Instance.deleteMany({ workspaceId });

  for (const Model of WORKSPACE_SCOPED_MODELS) {
    await Model.deleteMany({ workspaceId });
  }

  const users = await User.find({ workspaceId }).select('_id').lean();
  await Avatar.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  await User.deleteMany({ workspaceId });

  await Workspace.deleteOne({ _id: workspaceId });

  logger.info({ workspaceId, userCount: users.length, instanceCount: instances.length }, '[workspace-deletion] cascade complete');
}
