import { Schema, model, Document, Types } from 'mongoose';

export type LeadStatus = 'open' | 'won' | 'lost';
export type LeadSource = 'manual' | 'flow' | 'conversation' | 'campaign';

export interface ILead extends Document {
  workspaceId: Types.ObjectId;
  pipelineId: Types.ObjectId;
  stageId: string;
  contactId: Types.ObjectId;
  conversationId?: Types.ObjectId;
  title: string;
  value: number;
  currency: string;
  assigneeId?: Types.ObjectId;
  tags: string[];
  notes?: string;
  customFields?: Map<string, unknown>;
  status: LeadStatus;
  order: number;              // sort position within its stage
  source: LeadSource;
  expectedCloseDate?: Date;
  wonAt?: Date;
  lostAt?: Date;
  lostReason?: string;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema = new Schema<ILead>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    pipelineId:     { type: Schema.Types.ObjectId, ref: 'Pipeline', required: true },
    stageId:        { type: String, required: true },
    contactId:      { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    title:          { type: String, required: true, trim: true },
    value:          { type: Number, default: 0, min: 0 },
    currency:       { type: String, default: 'BRL' },
    assigneeId:     { type: Schema.Types.ObjectId, ref: 'User' },
    tags:           [{ type: String }],
    notes:          { type: String, default: '' },
    customFields:   { type: Map, of: Schema.Types.Mixed, default: {} },
    status:         { type: String, enum: ['open', 'won', 'lost'], default: 'open' },
    order:          { type: Number, default: 0 },
    source:         { type: String, enum: ['manual', 'flow', 'conversation', 'campaign'], default: 'manual' },
    expectedCloseDate: { type: Date },
    wonAt:          { type: Date },
    lostAt:         { type: Date },
    lostReason:     { type: String },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

LeadSchema.index({ workspaceId: 1, pipelineId: 1, stageId: 1, order: 1 });
LeadSchema.index({ workspaceId: 1, contactId: 1 });
LeadSchema.index({ workspaceId: 1, status: 1 });

LeadSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Lead = model<ILead>('Lead', LeadSchema);
