import { Schema, model, Document, Types } from 'mongoose';

/**
 * A workspace-level closing-reason catalog entry — referenced by its own `_id`
 * from `Conversation.closeReasonId`, not embedded by name, so deleting a reason
 * simply leaves old references pointing at nothing (UI shows "Motivo removido").
 */
export interface ICloseReason extends Document {
  workspaceId: Types.ObjectId;
  label: string;
  color: string; // hex, e.g. "#10B981"
  createdAt: Date;
  updatedAt: Date;
}

const CloseReasonSchema = new Schema<ICloseReason>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    label:       { type: String, required: true, trim: true },
    color:       { type: String, required: true, default: '#64748B' },
  },
  { timestamps: true }
);

CloseReasonSchema.index(
  { workspaceId: 1, label: 1 },
  { unique: true, collation: { locale: 'pt', strength: 2 } }
);

CloseReasonSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const CloseReason = model<ICloseReason>('CloseReason', CloseReasonSchema);
