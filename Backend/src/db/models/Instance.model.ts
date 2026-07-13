import { Schema, model, Document, Types } from 'mongoose';

export type InstanceStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'pairing_pending'
  | 'connected'
  | 'banned'
  | 'error';

export interface IInstance extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  phone?: string;
  status: InstanceStatus;
  qrCode?: string;       // base64 PNG
  pairingCode?: string;  // 8-digit code
  // Baileys auth state stored directly in document
  authCreds?: Record<string, unknown>;
  authKeys?: Record<string, Record<string, unknown>>;
  webhookUrl?: string;
  lastConnectedAt?: Date;
  lastDisconnectedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InstanceSchema = new Schema<IInstance>(
  {
    workspaceId:         { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:                { type: String, required: true, trim: true },
    phone:               { type: String },
    status:              { type: String, enum: ['disconnected', 'connecting', 'qr_pending', 'pairing_pending', 'connected', 'banned', 'error'], default: 'disconnected' },
    qrCode:              { type: String },
    pairingCode:         { type: String },
    authCreds:           { type: Schema.Types.Mixed },
    authKeys:            { type: Schema.Types.Mixed },
    webhookUrl:          { type: String },
    lastConnectedAt:     { type: Date },
    lastDisconnectedAt:  { type: Date },
    errorMessage:        { type: String },
  },
  { timestamps: true }
);

InstanceSchema.index({ workspaceId: 1 });
InstanceSchema.index({ status: 1 });

// Never return auth credentials in API responses
InstanceSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    delete r.authCreds;
    delete r.authKeys;
    return r;
  },
});

export const Instance = model<IInstance>('Instance', InstanceSchema);
