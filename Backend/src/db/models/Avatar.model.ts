import { Schema, model, Document, Types } from 'mongoose';

export interface IAvatar extends Document {
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  data: Buffer;
  mimeType: string;
  /** Real capability token (32 random bytes, hex) for the public avatar URL —
   *  optional because avatars saved before this field existed have no token to
   *  check against; those keep serving via the bare /avatar/:userId route (see
   *  auth.routes.ts). A fresh upload always gets a fresh token, so re-uploading
   *  incidentally invalidates any previously-leaked link too. */
  accessToken?: string;
  updatedAt: Date;
}

const AvatarSchema = new Schema<IAvatar>(
  {
    userId:      { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    data:        { type: Buffer, required: true },
    mimeType:    { type: String, required: true },
    accessToken: { type: String },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const Avatar = model<IAvatar>('Avatar', AvatarSchema);
