import { Schema, model, Document, Types } from 'mongoose';

export type NotificationType =
  | 'conversation.assigned' | 'conversation.transferred' | 'conversation.message' | 'conversation.reopened'
  | 'crm.lead_assigned' | 'crm.lead_stage_changed' | 'crm.lead_won' | 'crm.lead_lost'
  | 'flow.published' | 'flow.run_failed' | 'flow.transferred_to_human' | 'flow.custom'
  | 'team.invited' | 'team.role_changed' | 'team.password_reset'
  | 'instance.disconnected' | 'instance.qr_expired' | 'instance.banned' | 'instance.connected'
  | 'billing.plan_changed'
  | 'security.new_login'
  | 'campaign.completed'
  | 'sla.first_response_breached' | 'sla.resolution_breached'
  | 'workspace.deletion_requested' | 'workspace.deletion_cancelled';

export interface INotification extends Document {
  workspaceId: Types.ObjectId;
  recipientId: Types.ObjectId;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
  read: boolean;
  readAt?: Date;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type:        { type: String, required: true },
    title:       { type: String, required: true },
    message:     { type: String, required: true },
    link:        { type: String },
    metadata:    { type: Schema.Types.Mixed },
    read:        { type: Boolean, default: false },
    readAt:      { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

NotificationSchema.index({ workspaceId: 1, recipientId: 1, createdAt: -1 });
NotificationSchema.index({ workspaceId: 1, recipientId: 1, read: 1 });
// Auto-expire after 60 days so the collection doesn't grow unbounded.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

NotificationSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Notification = model<INotification>('Notification', NotificationSchema);
