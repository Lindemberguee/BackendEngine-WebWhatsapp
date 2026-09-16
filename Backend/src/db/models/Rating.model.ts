import { Schema, model, Document, Types } from 'mongoose';

/** A CSAT score collected after closing a conversation (see the "Solicitar
 *  avaliação" toggle on the attendance.close flow block). agentId/teamGroupId
 *  are a snapshot of who was actually handling the conversation at close time —
 *  Conversation.assignedAgentId is cleared on resolve, so this is the only
 *  record of who earned (or didn't) this score once that happens. */
export interface IRating extends Document {
  workspaceId: Types.ObjectId;
  conversationId: Types.ObjectId;
  contactId?: Types.ObjectId;
  agentId?: Types.ObjectId;
  teamGroupId?: Types.ObjectId;
  score: number;
  comment?: string;
  createdAt: Date;
}

const RatingSchema = new Schema<IRating>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    agentId: { type: Schema.Types.ObjectId, ref: 'User' },
    teamGroupId: { type: Schema.Types.ObjectId, ref: 'TeamGroup' },
    score: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Covers the Reports CSAT card: workspace-wide average/distribution over a date
// range, and the per-agent / per-team breakdown.
RatingSchema.index({ workspaceId: 1, createdAt: -1 });
RatingSchema.index({ workspaceId: 1, agentId: 1 });
RatingSchema.index({ workspaceId: 1, teamGroupId: 1 });
// At most one rating per conversation — a second reply after scoring shouldn't
// double-count (the run is 'completed' by then anyway, but this guards direct
// writes too).
RatingSchema.index({ conversationId: 1 }, { unique: true });

export const Rating = model<IRating>('Rating', RatingSchema);
