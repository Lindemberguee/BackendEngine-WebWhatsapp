import { Schema, model, Document, Types } from 'mongoose';

/**
 * A workspace-level label (etiqueta) catalog entry. Labels are shared across
 * conversations and contacts: the documents store label *names* in their `tags`
 * array, while this collection defines the canonical name + color for each label.
 * Renaming/recoloring here is reflected everywhere; deleting cascades a $pull from
 * Conversation.tags and Contact.tags (handled in the routes).
 */
export interface ILabel extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  color: string; // hex, e.g. "#10B981"
  createdAt: Date;
  updatedAt: Date;
}

const LabelSchema = new Schema<ILabel>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:        { type: String, required: true, trim: true },
    color:       { type: String, required: true, default: '#64748B' },
  },
  { timestamps: true }
);

// One label name per workspace (case-insensitive uniqueness via collation).
LabelSchema.index(
  { workspaceId: 1, name: 1 },
  { unique: true, collation: { locale: 'pt', strength: 2 } }
);

LabelSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Label = model<ILabel>('Label', LabelSchema);
