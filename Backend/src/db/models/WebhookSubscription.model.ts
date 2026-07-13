import { Schema, model, Document, Types } from 'mongoose';

export type WebhookEvent =
  | 'message.received' | 'conversation.resolved' | 'crm.lead_won' | 'crm.lead_lost' | 'campaign.completed';

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'message.received', 'conversation.resolved', 'crm.lead_won', 'crm.lead_lost', 'campaign.completed',
];

export interface IWebhookSubscription extends Document {
  workspaceId: Types.ObjectId;
  url: string;
  /** Used to sign delivery payloads (HMAC-SHA256, X-Webhook-Signature header) — shown to the user, not a secret we keep hidden from them. */
  secret: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WebhookSubscriptionSchema = new Schema<IWebhookSubscription>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    url:         { type: String, required: true, trim: true },
    secret:      { type: String, required: true },
    events:      [{ type: String, enum: WEBHOOK_EVENTS }],
    enabled:     { type: Boolean, default: true },
  },
  { timestamps: true }
);

WebhookSubscriptionSchema.index({ workspaceId: 1 });
WebhookSubscriptionSchema.index({ workspaceId: 1, enabled: 1, events: 1 });

export const WebhookSubscription = model<IWebhookSubscription>('WebhookSubscription', WebhookSubscriptionSchema);
