import { Schema, model, Document, Types } from 'mongoose';

export interface IWorkspace extends Document {
  name: string;
  slug: string;
  /** Denormalized copy of the active Subscription's plan tier — kept in sync by billing.service.ts, cheap to read from anywhere without a join. */
  plan: 'starter' | 'pro' | 'enterprise';
  ownerId: Types.ObjectId;
  logoUrl?: string;
  settings: Record<string, unknown>;
  /** Platform-level suspension. Suspended workspaces cannot authenticate or use API keys. */
  status: 'active' | 'suspended';
  suspendedAt?: Date;
  /** Set when the owner requests account deletion (LGPD right to erasure) — cleared on cancel. */
  deletionRequestedAt?: Date;
  /** Cascade-delete runs once this passes (see workspace-deletion-scheduler.ts) — a 30-day grace window from the request. */
  deletionScheduledFor?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name:     { type: String, required: true, trim: true },
    slug:     { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan:     { type: String, enum: ['starter', 'pro', 'enterprise'], default: 'starter' },
    ownerId:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
    logoUrl:  { type: String },
    settings: { type: Schema.Types.Mixed, default: {} },
    status:   { type: String, enum: ['active', 'suspended'], default: 'active' },
    suspendedAt: { type: Date },
    deletionRequestedAt: { type: Date },
    deletionScheduledFor: { type: Date },
  },
  { timestamps: true }
);

WorkspaceSchema.index({ deletionScheduledFor: 1 });
WorkspaceSchema.index({ status: 1, createdAt: -1 });

export const Workspace = model<IWorkspace>('Workspace', WorkspaceSchema);
