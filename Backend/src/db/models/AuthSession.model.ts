import { Schema, model, Document, Types } from 'mongoose';

export interface IAuthSession extends Document {
  userId: Types.ObjectId;
  tokenVersion: number;
  workspaceId: Types.ObjectId;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AuthSessionSchema = new Schema<IAuthSession>(
  {
    tokenVersion: { type: Number, default: 0 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

AuthSessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

export const AuthSession = model<IAuthSession>('AuthSession', AuthSessionSchema);
