import { Schema, model, Document, Types } from 'mongoose';

export type WebhookInboundStatus = 'success' | 'error';

export interface IWebhookInboundLog extends Document {
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  flowName: string;
  status: WebhookInboundStatus;
  error?: string;
  payload: Record<string, unknown>;
  conversationId?: Types.ObjectId;
  createdAt: Date;
}

const WebhookInboundLogSchema = new Schema<IWebhookInboundLog>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    flowId:         { type: Schema.Types.ObjectId, ref: 'Flow', required: true },
    flowName:       { type: String, required: true },
    status:         { type: String, enum: ['success', 'error'], required: true },
    error:          { type: String },
    payload:        { type: Schema.Types.Mixed, default: {} },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

WebhookInboundLogSchema.index({ workspaceId: 1, flowId: 1, createdAt: -1 });

// Auto-expire after 30 days — mirrors WebhookDelivery.model.ts's TTL pattern.
WebhookInboundLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

WebhookInboundLogSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const WebhookInboundLog = model<IWebhookInboundLog>('WebhookInboundLog', WebhookInboundLogSchema);
