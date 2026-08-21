import type { IPricingRate } from '../db/models';

/**
 * Resolves a phone number's country calling code against the platform's
 * rate-card rows and returns the matching region — the country/region
 * dimension Meta's own rate card is priced by. Meta's public rate card mixes
 * standalone countries with shared regional buckets ("Rest of Africa" etc.),
 * so this is a longest-prefix match against whatever calling codes are
 * currently configured, not a hardcoded country list of our own.
 *
 * `rates` should be every PricingRate row for the category being priced (any
 * currency/effectiveFrom — the caller picks which one to use); this function
 * only cares about `region` + `countryCallingCodes`.
 */
export function resolveRegionForPhone(
  phone: string,
  rates: Pick<IPricingRate, 'region' | 'countryCallingCodes'>[]
): string | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;

  const regions = new Map<string, string[]>();
  for (const rate of rates) {
    if (!regions.has(rate.region)) regions.set(rate.region, rate.countryCallingCodes);
  }

  // Longest calling code first — '55' (Brazil) must win over a hypothetical
  // shorter prefix that also matches the same digits.
  let bestRegion: string | null = null;
  let bestLength = -1;
  let fallbackRegion: string | null = null;
  for (const [region, codes] of regions) {
    if (codes.length === 0) {
      fallbackRegion = region; // the "rest of world" bucket, if configured
      continue;
    }
    for (const code of codes) {
      if (code && digits.startsWith(code) && code.length > bestLength) {
        bestRegion = region;
        bestLength = code.length;
      }
    }
  }
  return bestRegion ?? fallbackRegion;
}
