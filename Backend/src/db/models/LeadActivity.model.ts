import { Schema, model, Document, Types } from 'mongoose';

export type LeadActivityType =
  | 'created'
  | 'stage_changed'
  | 'note_added'
  | 'value_changed'
  | 'assigned'
  | 'won'
  | 'lost'
  | 'tag_added'
  | 'tag_removed';

export interface ILeadActivity extends Document {
  workspaceId: Types.ObjectId;
  leadId: Types.ObjectId;
  type: LeadActivityType;
  actorId?: Types.ObjectId;   // user who performed it; absent = system/flow
  actorName?: string;         // denormalized for display without a populate
  message: string;            // human-readable summary, e.g. "Movido de Qualificado para Ganho"
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const LeadActivitySchema = new Schema<ILeadActivity>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    leadId:      { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    type: {
      type: String,
      enum: ['created', 'stage_changed', 'note_added', 'value_changed', 'assigned', 'won', 'lost', 'tag_added', 'tag_removed'],
      required: true,
    },
    actorId:   { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String },
    message:   { type: String, required: true },
    metadata:  { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

LeadActivitySchema.index({ workspaceId: 1, leadId: 1, createdAt: -1 });

LeadActivitySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const LeadActivity = model<ILeadActivity>('LeadActivity', LeadActivitySchema);
