import { Schema, model, Types } from 'mongoose';

// Credentials belong to an account; User is a workspace membership.
// Legacy users are claimed individually after password verification, never by email.
const schema = new Schema({
  email: { type: String, required: true, index: true },
  passwordHash: { type: String, required: true },
  signupEmail: { type: String },
}, { timestamps: true });
schema.index({ signupEmail: 1 }, { unique: true, sparse: true });
export const Account = model('Account', schema);
export type AccountId = Types.ObjectId;
