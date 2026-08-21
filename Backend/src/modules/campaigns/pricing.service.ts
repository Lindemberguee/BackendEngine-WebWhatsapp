import { Instance, PricingRate } from '../../db/models';
import type { ICampaignAudience } from '../../db/models';
import { resolveAudience, type LeanContact } from './campaign.service';
import { resolveRegionForPhone } from '../../shared/phone-country';

export interface CostEstimateByCountry {
  region: string;
  label: string;
  count: number;
  currency: string;
  unitCents: number;
  subtotalCents: number;
}

export interface CampaignCostEstimate {
  currency: string | null;
  totalCents: number;
  eligibleCount: number;
  /** Contacts whose country doesn't match any configured rate — not counted
   *  in totalCents, surfaced so the estimate never silently understates cost. */
  uncosted: number;
  byCountry: CostEstimateByCountry[];
  /** True if any rate actually used still has the PENDENTE placeholder
   *  price (0 cents) — the UI shows a warning instead of trusting the total. */
  hasPendingRates: boolean;
}

const EMPTY_ESTIMATE: CampaignCostEstimate = { currency: null, totalCents: 0, eligibleCount: 0, uncosted: 0, byCountry: [], hasPendingRates: false };

/**
 * Estimates what a template campaign will cost, using the platform's own rate
 * card (PricingRate) — Meta has no live quote API, only a static published
 * rate card, so this is necessarily an estimate, not a bill. Mirrors the same
 * audience resolution + opt-in filter `audience-preview` already applies, so
 * the contact count here always matches what the wizard shows as "eligible".
 */
export async function estimateCampaignCost(
  workspaceId: string,
  audience: ICampaignAudience,
  instanceIds: string[],
  templateCategory: string | undefined
): Promise<CampaignCostEstimate> {
  if (!templateCategory || !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(templateCategory)) return EMPTY_ESTIMATE;

  let contacts: LeanContact[] = await resolveAudience(workspaceId, audience);
  const usesOfficialChannel = instanceIds.length > 0 && Boolean(await Instance.exists({ _id: { $in: instanceIds }, workspaceId, channel: 'cloud_api' }));
  if (usesOfficialChannel) contacts = contacts.filter((c) => Boolean(c.whatsappOptInAt));
  if (contacts.length === 0) return EMPTY_ESTIMATE;

  const rates = await PricingRate.find({ category: templateCategory }).lean();
  if (rates.length === 0) return { ...EMPTY_ESTIMATE, eligibleCount: contacts.length, uncosted: contacts.length };

  const byRegion = new Map<string, LeanContact[]>();
  let uncosted = 0;
  for (const contact of contacts) {
    const region = resolveRegionForPhone(contact.phone, rates);
    if (!region) { uncosted++; continue; }
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region)!.push(contact);
  }

  const byCountry: CostEstimateByCountry[] = [];
  let totalCents = 0;
  let hasPendingRates = false;
  // All rates share one currency in practice (one platform, one rate-card
  // maintainer) — take the first rate's currency as the estimate's currency;
  // a region priced in a different currency would need real multi-currency
  // totals, which isn't needed yet with only Brazil seeded.
  const currency = rates[0]?.currency ?? null;

  for (const [region, regionContacts] of byRegion) {
    const rate = rates.find((r) => r.region === region);
    if (!rate) { uncosted += regionContacts.length; continue; }
    if (rate.priceCents === 0) hasPendingRates = true;
    const subtotalCents = rate.priceCents * regionContacts.length;
    totalCents += subtotalCents;
    byCountry.push({ region: rate.region, label: rate.label, count: regionContacts.length, currency: rate.currency, unitCents: rate.priceCents, subtotalCents });
  }

  byCountry.sort((a, b) => b.count - a.count);
  return { currency, totalCents, eligibleCount: contacts.length, uncosted, byCountry, hasPendingRates };
}
