import { Schema, model, Document, Types } from 'mongoose';

export interface IFlowFolder extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  color: string;
  description?: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const FlowFolderSchema = new Schema<IFlowFolder>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#8B5CF6' },
    description: { type: String },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

FlowFolderSchema.index({ workspaceId: 1, order: 1 });

FlowFolderSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const FlowFolder = model<IFlowFolder>('FlowFolder', FlowFolderSchema);
