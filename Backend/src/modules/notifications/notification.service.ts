import { Types } from 'mongoose';
import { Notification, Workspace, User, TeamGroup, Conversation } from '../../db/models';
import type { NotificationType, UserRole } from '../../db/models';
import type { WebSocketGateway } from '../../ws/gateway';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function toNotificationResponse(doc: {
  _id: Types.ObjectId; type: string; title: string; message: string; link?: string;
  metadata?: Record<string, unknown>; read: boolean; readAt?: Date; createdAt: Date;
}) {
  return {
    id: doc._id.toString(), type: doc.type, title: doc.title, message: doc.message,
    link: doc.link, metadata: doc.metadata, read: doc.read,
    readAt: doc.readAt?.toISOString(), createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Create a notification for one recipient and push it over WebSocket immediately
 * (falls back gracefully to poll-on-next-load if the recipient is offline — the
 * doc is still persisted). Never throws — a notification failure must never break
 * the business action that triggered it (e.g. assigning a conversation).
 */
export async function notify(
  gateway: WebSocketGateway,
  params: {
    workspaceId: string;
    recipientId: string;
    type: NotificationType;
    title: string;
    message: string;
    link?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    if (!Types.ObjectId.isValid(params.recipientId)) return;
    const doc = await Notification.create({
      workspaceId: params.workspaceId,
      recipientId: params.recipientId,
      type: params.type,
      title: params.title,
      message: params.message,
      link: params.link,
      metadata: params.metadata,
    });
    gateway.sendToUser(params.recipientId, 'notification:new', { notification: toNotificationResponse(doc) });
  } catch (err) {
    logger.warn({ err, type: params.type }, '[notifications] failed to create/send');
  }
}

/** Convenience for events tied to the workspace itself (instance/billing) rather than one agent's action. */
export async function notifyWorkspaceOwner(
  gateway: WebSocketGateway,
  workspaceId: string,
  params: Omit<Parameters<typeof notify>[1], 'workspaceId' | 'recipientId'>
): Promise<void> {
  try {
    const ws = await Workspace.findById(workspaceId).select('ownerId').lean();
    if (!ws?.ownerId) return;
    await notify(gateway, { ...params, workspaceId, recipientId: ws.ownerId.toString() });
  } catch (err) {
    logger.warn({ err }, '[notifications] notifyWorkspaceOwner failed');
  }
}

/** Send the same notification to several recipients (deduped) — never throws. */
export async function notifyMany(
  gateway: WebSocketGateway,
  recipientIds: string[],
  params: Omit<Parameters<typeof notify>[1], 'recipientId'>
): Promise<void> {
  const unique = [...new Set(recipientIds.filter((id) => Types.ObjectId.isValid(id)))];
  await Promise.all(unique.map((recipientId) => notify(gateway, { ...params, recipientId })));
}

export type NotificationTargetType = 'agent' | 'team_group' | 'role' | 'assigned_agent' | 'owner';

/**
 * Resolve a flow-configured notification target (a specific agent, a whole team
 * group, everyone with a role, whoever's currently assigned to the conversation,
 * or the workspace owner) into a concrete list of recipient user ids.
 */
export async function resolveNotificationTargets(
  workspaceId: string,
  target: { targetType: NotificationTargetType; agentId?: string; teamGroupId?: string; role?: UserRole; conversationId?: string }
): Promise<string[]> {
  try {
    switch (target.targetType) {
      case 'agent':
        return target.agentId && Types.ObjectId.isValid(target.agentId) ? [target.agentId] : [];

      case 'team_group': {
        if (!target.teamGroupId || !Types.ObjectId.isValid(target.teamGroupId)) return [];
        const group = await TeamGroup.findOne({ _id: target.teamGroupId, workspaceId }).select('memberIds').lean();
        return (group?.memberIds ?? []).map((id) => id.toString());
      }

      case 'role': {
        if (!target.role) return [];
        const users = await User.find({ workspaceId, role: target.role, isActive: true }).select('_id').lean();
        return users.map((u) => u._id.toString());
      }

      case 'assigned_agent': {
        if (!target.conversationId) return [];
        const conv = await Conversation.findById(target.conversationId).select('assignedAgentId').lean();
        return conv?.assignedAgentId ? [conv.assignedAgentId.toString()] : [];
      }

      case 'owner': {
        const ws = await Workspace.findById(workspaceId).select('ownerId').lean();
        return ws?.ownerId ? [ws.ownerId.toString()] : [];
      }

      default:
        return [];
    }
  } catch (err) {
    logger.warn({ err, target }, '[notifications] resolveNotificationTargets failed');
    return [];
  }
}
