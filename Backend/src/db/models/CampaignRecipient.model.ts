import { Schema, model, Document, Types } from 'mongoose';

export type CampaignRecipientStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';
export type CampaignSkipReason = 'blocked' | 'opted_out' | 'invalid_number';

export interface ICampaignRecipient extends Document {
  workspaceId: Types.ObjectId;
  campaignId: Types.ObjectId;
  contactId: Types.ObjectId;
  jid: string;
  name?: string;
  status: CampaignRecipientStatus;
  instanceId?: Types.ObjectId;
  messageId?: string;
  conversationId?: Types.ObjectId;
  error?: string;
  skipReason?: CampaignSkipReason;
  sentAt?: Date;
  /** Set the first time this contact replies after receiving the campaign message. */
  repliedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignRecipientSchema = new Schema<ICampaignRecipient>(
  {
    workspaceId:    { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    campaignId:     { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    contactId:      { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    jid:            { type: String, required: true },
    name:           { type: String },
    status:         { type: String, enum: ['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'], default: 'pending' },
    instanceId:     { type: Schema.Types.ObjectId, ref: 'Instance' },
    messageId:      { type: String },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    error:          { type: String },
    skipReason:     { type: String, enum: ['blocked', 'opted_out', 'invalid_number'] },
    sentAt:         { type: Date },
    repliedAt:      { type: Date },
  },
  { timestamps: true }
);

CampaignRecipientSchema.index({ workspaceId: 1, campaignId: 1, status: 1 });
CampaignRecipientSchema.index({ workspaceId: 1, instanceId: 1, sentAt: -1 });
CampaignRecipientSchema.index({ messageId: 1 });
CampaignRecipientSchema.index({ workspaceId: 1, jid: 1, sentAt: -1 });

CampaignRecipientSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const CampaignRecipient = model<ICampaignRecipient>('CampaignRecipient', CampaignRecipientSchema);
