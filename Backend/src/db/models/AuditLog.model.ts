import { Schema, model, Document, Types } from 'mongoose';

export interface IAuditLog extends Document {
  workspaceId: Types.ObjectId;
  actor: { id: Types.ObjectId; name: string; email: string };
  type: string;
  target?: { type: string; id: string; label: string };
  metadata?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    actor: {
      id:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
      name:  { type: String, required: true },
      email: { type: String, required: true },
    },
    type:   { type: String, required: true },
    target: {
      type:  { type: String },
      id:    { type: String },
      label: { type: String },
    },
    metadata: { type: Schema.Types.Mixed },
    ip:       { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ workspaceId: 1, createdAt: -1 });
AuditLogSchema.index({ workspaceId: 1, type: 1 });

// Auto-expire audit logs after 90 days
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const AuditLog = model<IAuditLog>('AuditLog', AuditLogSchema);
