import { Schema, model, Document, Types } from 'mongoose';
import type { WebhookEvent } from './WebhookSubscription.model';

export type WebhookDeliveryStatus = 'pending' | 'success' | 'failed';

export interface IWebhookDelivery extends Document {
  workspaceId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  responseStatus?: number;
  error?: string;
  createdAt: Date;
}

const WebhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'WebhookSubscription', required: true },
    event:          { type: String, required: true },
    payload:        { type: Schema.Types.Mixed, default: {} },
    status:         { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    attempts:       { type: Number, default: 0 },
    nextAttemptAt:  { type: Date, required: true, default: Date.now },
    responseStatus: { type: Number },
    error:          { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

WebhookDeliverySchema.index({ subscriptionId: 1, createdAt: -1 });
WebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

// Auto-expire delivery logs after 30 days — mirrors AuditLog.model.ts's TTL pattern.
WebhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

WebhookDeliverySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const WebhookDelivery = model<IWebhookDelivery>('WebhookDelivery', WebhookDeliverySchema);
