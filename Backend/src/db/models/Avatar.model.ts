import { Schema, model, Document, Types } from 'mongoose';

export interface IAvatar extends Document {
  userId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  data: Buffer;
  mimeType: string;
  updatedAt: Date;
}

const AvatarSchema = new Schema<IAvatar>(
  {
    userId:      { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    data:        { type: Buffer, required: true },
    mimeType:    { type: String, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const Avatar = model<IAvatar>('Avatar', AvatarSchema);
