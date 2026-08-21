import { Schema, model, Document, Types } from 'mongoose';

/**
 * A workspace-level canned/quick-reply message — agents pick one from the chat
 * composer to drop a pre-written message into the draft, and flows can send one
 * directly via the `message.quick_reply` block. Unlike Label, these are
 * referenced by their own `_id` wherever they're used (not embedded by name
 * into other documents), so there's no rename/delete cascade to worry about.
 */
export interface IQuickReply extends Document {
  workspaceId: Types.ObjectId;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

const QuickReplySchema = new Schema<IQuickReply>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    title:       { type: String, required: true, trim: true },
    content:     { type: String, required: true },
  },
  { timestamps: true }
);

QuickReplySchema.index({ workspaceId: 1 });

QuickReplySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const QuickReply = model<IQuickReply>('QuickReply', QuickReplySchema);
