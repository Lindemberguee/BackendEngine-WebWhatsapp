import { Schema, model, Document, Types } from 'mongoose';

export type MetaWebhookEventStatus = 'pending' | 'processing' | 'processed' | 'retry' | 'dead';

export interface IMetaWebhookEvent extends Document {
  workspaceId: Types.ObjectId;
  instanceId: Types.ObjectId;
  digest: string;
  payload: Record<string, unknown>;
  status: MetaWebhookEventStatus;
  attempts: number;
  nextAttemptAt?: Date;
  processedAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const MetaWebhookEventSchema = new Schema<IMetaWebhookEvent>({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  instanceId: { type: Schema.Types.ObjectId, ref: 'Instance', required: true },
  digest: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['pending', 'processing', 'processed', 'retry', 'dead'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date },
  processedAt: { type: Date },
  error: { type: String },
}, { timestamps: true });

MetaWebhookEventSchema.index({ instanceId: 1, digest: 1 }, { unique: true });
MetaWebhookEventSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
MetaWebhookEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const MetaWebhookEvent = model<IMetaWebhookEvent>('MetaWebhookEvent', MetaWebhookEventSchema);
