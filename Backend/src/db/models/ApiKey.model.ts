import { Schema, model, Document, Types } from 'mongoose';
import type { UserRole } from './User.model';

/** Roles an API key may carry — never 'owner', that's too much power for a bearer credential. */
export type ApiKeyRole = Exclude<UserRole, 'owner'>;

export interface IApiKey extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  /** First ~18 chars of the full key, kept for display/identification — the rest is never stored. */
  keyPrefix: string;
  /** SHA-256 hex digest of the full key — high-entropy secret, so a fast hash + direct lookup is fine (unlike bcrypt for user passwords). */
  keyHash: string;
  role: ApiKeyRole;
  createdBy: Types.ObjectId;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema = new Schema<IApiKey>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:        { type: String, required: true, trim: true, maxlength: 80 },
    keyPrefix:   { type: String, required: true },
    keyHash:     { type: String, required: true, unique: true },
    role:        { type: String, enum: ['admin', 'agent', 'viewer'], default: 'agent' },
    createdBy:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastUsedAt:  { type: Date },
    revokedAt:   { type: Date },
  },
  { timestamps: true }
);

ApiKeySchema.index({ workspaceId: 1 });

ApiKeySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    delete r.keyHash; // never expose the hash, even to the owning workspace
    return r;
  },
});

export const ApiKey = model<IApiKey>('ApiKey', ApiKeySchema);
