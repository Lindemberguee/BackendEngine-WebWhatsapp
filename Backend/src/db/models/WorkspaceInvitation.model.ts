import { Schema, model } from 'mongoose';
const schema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  email: { type: String, required: true }, name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'agent', 'viewer'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  acceptedBy: { type: Schema.Types.ObjectId, ref: 'Account' }, acceptedAt: Date,
}, { timestamps: true });
export const WorkspaceInvitation = model('WorkspaceInvitation', schema);
