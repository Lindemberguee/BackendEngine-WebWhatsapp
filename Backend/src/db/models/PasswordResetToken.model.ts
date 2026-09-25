import { Schema, model } from 'mongoose';

const schema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// One active reset link per account; concurrent requests replace the token atomically.
schema.index({ accountId: 1 }, { unique: true });
schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordResetToken = model('PasswordResetToken', schema);
