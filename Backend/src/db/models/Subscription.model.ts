import { Schema, model, Document, Types } from 'mongoose';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';
export type BillingCycle = 'monthly' | 'annual';

/**
 * One per workspace. `externalCustomerId`/`externalSubscriptionId`/`provider`
 * are staged for a real payment gateway (Stripe et al.) — until one is wired,
 * `provider` stays 'manual' and plan changes are applied directly by
 * billing.service.ts with no actual charge. Swapping in a real gateway later
 * means implementing PaymentGateway (see payment-gateway.ts) and populating
 * these fields; nothing else here has to change.
 */
export interface ISubscription extends Document {
  workspaceId: Types.ObjectId;
  planId: string;
  status: SubscriptionStatus;
  cycle: BillingCycle;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt?: Date;
  cancelAtPeriodEnd: boolean;
  provider: 'manual' | 'stripe';
  externalCustomerId?: string;
  externalSubscriptionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    workspaceId:      { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true },
    planId:           { type: String, required: true },
    status:           { type: String, enum: ['trialing', 'active', 'past_due', 'canceled', 'paused'], default: 'trialing' },
    cycle:            { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd:   { type: Date, required: true },
    trialEndsAt:      { type: Date },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    provider:         { type: String, enum: ['manual', 'stripe'], default: 'manual' },
    externalCustomerId:     { type: String },
    externalSubscriptionId: { type: String },
  },
  { timestamps: true }
);

SubscriptionSchema.index({ workspaceId: 1 }, { unique: true });
SubscriptionSchema.index({ status: 1, trialEndsAt: 1 });

SubscriptionSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    delete r.externalCustomerId;
    delete r.externalSubscriptionId;
    return r;
  },
});

export const Subscription = model<ISubscription>('Subscription', SubscriptionSchema);
