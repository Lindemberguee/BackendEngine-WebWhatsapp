import { PricingRate } from '../../db/models';
import { resolveRegionForPhone } from '../../shared/phone-country';

export interface ResolvedRate {
  region: string;
  currency: string;
  priceCents: number;
}

/**
 * Looks up the platform's rate-card price for a single (phone, category) pair
 * — the per-send cost calculation `sendNextRecipient` uses once a message
 * actually goes out. Split into its own module (rather than living in
 * pricing.service.ts, which imports campaign.service.ts for audience
 * resolution) so campaign.service.ts can use it without an import cycle.
 */
export async function findRateForSend(phone: string, category: string): Promise<ResolvedRate | null> {
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) return null;
  const rates = await PricingRate.find({ category }).lean();
  if (rates.length === 0) return null;
  const region = resolveRegionForPhone(phone, rates);
  if (!region) return null;
  const rate = rates.find((r) => r.region === region);
  if (!rate) return null;
  return { region: rate.region, currency: rate.currency, priceCents: rate.priceCents };
}
