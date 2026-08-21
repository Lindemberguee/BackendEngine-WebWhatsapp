import { Schema, model, Document } from 'mongoose';

/** Mirrors the three billable template categories Meta reports on
 *  WhatsAppTemplate.category — SERVICE (session/non-template) messages are
 *  free and intentionally have no rate row. */
export type PricingCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/**
 * A platform-wide (not per-workspace) rate card row — this is Meta's own
 * price, not something a workspace configures. Meta doesn't expose a live
 * quote API; it only publishes a static rate card by country/category that
 * changes quarterly (business.whatsapp.com/products/platform-pricing), so
 * this collection is the thing platform admins keep in sync by hand.
 */
export interface IPricingRate extends Document {
  /** Short region code, e.g. 'BR'. Not necessarily ISO — matches however the
   *  rate card groups countries (some are standalone, some share a regional
   *  bucket like "Rest of Africa"). */
  region: string;
  /** Human label shown in the admin UI, e.g. "Brasil". */
  label: string;
  /** Country calling codes (no leading '+') that resolve to this region, e.g.
   *  ['55'] for Brazil. Empty array = the catch-all "rest of world" bucket —
   *  at most one row per category may have an empty array. */
  countryCallingCodes: string[];
  category: PricingCategory;
  /** ISO 4217 currency code the price is denominated in, e.g. 'BRL'. */
  currency: string;
  priceCents: number;
  /** When this price took effect — Meta revises rate cards on fixed dates
   *  (Jan/Apr/Jul/Oct 1st); kept so a future rate change doesn't silently
   *  overwrite history, even though only the latest row per (region,
   *  category) is used today. */
  effectiveFrom: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PricingRateSchema = new Schema<IPricingRate>(
  {
    region:               { type: String, required: true, uppercase: true, trim: true },
    label:                { type: String, required: true, trim: true },
    countryCallingCodes:  [{ type: String, trim: true }],
    category:             { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], required: true },
    currency:             { type: String, required: true, uppercase: true, trim: true },
    priceCents:           { type: Number, required: true, min: 0 },
    effectiveFrom:        { type: Date, required: true, default: Date.now },
    notes:                { type: String, trim: true },
  },
  { timestamps: true }
);

PricingRateSchema.index({ region: 1, category: 1 }, { unique: true });

PricingRateSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    r.id = (r._id as { toString(): string } | undefined)?.toString();
    delete r._id;
    delete r.__v;
    return r;
  },
});

export const PricingRate = model<IPricingRate>('PricingRate', PricingRateSchema);
