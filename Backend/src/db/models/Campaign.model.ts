import { Schema, model, Document, Types } from 'mongoose';

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled';
export type AudienceType = 'all' | 'tag' | 'crm_stage' | 'manual';

export interface ICampaignAudience {
  type: AudienceType;
  tags?: string[];
  pipelineId?: Types.ObjectId;
  stageId?: string;
  contactIds?: Types.ObjectId[];
}

/**
 * A campaign message is stored as a flow block (blockType + config) so it can
 * send ANY of the message formats the flow builder supports (text, media,
 * interactive buttons, list, poll, location, contact, Pix…) via the exact same
 * `buildMessageContent()` used by the flow runner — no separate message model
 * to keep in sync.
 */
export interface ICampaignMessageBlock {
  blockType: string;
  config: Record<string, unknown>;
}

export interface ICampaignThrottle {
  minDelaySeconds: number;
  maxDelaySeconds: number;
  maxPerInstancePerHour: number;
  maxPerInstancePerDay: number;
}

export interface ICampaignStats {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
  /** Sum of every successfully-sent recipient's estimatedCostCents (see
   *  CampaignRecipient) — the platform's own rate-card estimate, not Meta's
   *  actual bill. Only sends that really went out are counted, unlike the
   *  pre-send estimate which includes contacts that may later be skipped. */
  estimatedCostCents: number;
}

export interface ICampaign extends Document {
  workspaceId: Types.ObjectId;
  name: string;
  status: CampaignStatus;
  createdBy: Types.ObjectId;
  instanceIds: Types.ObjectId[];
  /** Round-robin cursor into instanceIds, so consecutive sends rotate across numbers. */
  lastInstanceIndex: number;
  audience: ICampaignAudience;
  message: ICampaignMessageBlock;
  /** Appends an opt-out hint ("responda PARAR") to the sent text/caption — recipients otherwise have no way to know the keyword works. */
  includeOptOutFooter: boolean;
  throttle: ICampaignThrottle;
  scheduledAt?: Date;
  /** Cursor the dispatcher uses to know when this campaign's next message is due. */
  nextSendAt?: Date;
  /** Consecutive send failures — auto-pauses the campaign past a threshold (possible ban/connectivity signal). */
  consecutiveFailures: number;
  /** Last time the owner was notified that no configured instance has a ready
   *  session — dedup guard so a campaign stuck in 'no_capacity' doesn't spam a
   *  notification on every dispatcher tick while it's stalled. */
  sessionAlertedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  stats: ICampaignStats;
  /** Currency stats.estimatedCostCents is denominated in — set on the first
   *  costed send; a campaign only ever spans one currency in practice (one
   *  rate-card maintainer, one platform). */
  estimatedCostCurrency?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignSchema = new Schema<ICampaign>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    name:        { type: String, required: true, trim: true },
    status:      { type: String, enum: ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled'], default: 'draft' },
    createdBy:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
    instanceIds: [{ type: Schema.Types.ObjectId, ref: 'Instance' }],
    lastInstanceIndex: { type: Number, default: -1 },
    audience: {
      type:        { type: String, enum: ['all', 'tag', 'crm_stage', 'manual'], required: true },
      tags:        [{ type: String }],
      pipelineId:  { type: Schema.Types.ObjectId, ref: 'Pipeline' },
      stageId:     { type: String },
      contactIds:  [{ type: Schema.Types.ObjectId, ref: 'Contact' }],
    },
    message: {
      blockType: { type: String, required: true },
      config:    { type: Schema.Types.Mixed, default: {} },
    },
    includeOptOutFooter: { type: Boolean, default: true },
    throttle: {
      minDelaySeconds:        { type: Number, default: 5 },
      maxDelaySeconds:        { type: Number, default: 15 },
      maxPerInstancePerHour:  { type: Number, default: 60 },
      maxPerInstancePerDay:   { type: Number, default: 300 },
    },
    scheduledAt: { type: Date },
    nextSendAt:  { type: Date },
    consecutiveFailures: { type: Number, default: 0 },
    sessionAlertedAt: { type: Date },
    startedAt:   { type: Date },
    completedAt: { type: Date },
    stats: {
      total:     { type: Number, default: 0 },
      pending:   { type: Number, default: 0 },
      sent:      { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read:      { type: Number, default: 0 },
      replied:   { type: Number, default: 0 },
      failed:    { type: Number, default: 0 },
      skipped:   { type: Number, default: 0 },
      estimatedCostCents: { type: Number, default: 0 },
    },
    estimatedCostCurrency: { type: String },
  },
  { timestamps: true }
);

CampaignSchema.index({ workspaceId: 1, status: 1 });
CampaignSchema.index({ workspaceId: 1, createdAt: -1 });

CampaignSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const Campaign = model<ICampaign>('Campaign', CampaignSchema);
