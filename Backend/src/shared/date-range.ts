/** Shared date-range helpers for analytics/reports aggregations. */

export function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / 86_400_000);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build one bucket per calendar day in [from, to], each starting at 0 for every key. */
export function emptyDailyBuckets<T extends string>(
  from: Date, to: Date, keys: T[]
): Record<string, { date: string } & Record<T, number>> {
  const map: Record<string, { date: string } & Record<T, number>> = {};
  let cur = startOfDay(from);
  const end = startOfDay(to);
  while (cur <= end) {
    const k = isoDate(cur);
    map[k] = { date: k, ...Object.fromEntries(keys.map((key) => [key, 0])) } as { date: string } & Record<T, number>;
    cur = addDays(cur, 1);
  }
  return map;
}

/** Resolve a { from, to } range from query params: explicit from/to (ISO dates)
 *  win, otherwise `period` ("today" | "30d" | else defaults to 7d). */
export function resolveDateRange(q: Record<string, string>): { from: Date; to: Date } {
  const now = new Date();
  let from: Date;
  const to: Date = q.to ? new Date(q.to) : now;
  if (q.from) {
    from = new Date(q.from);
  } else if (q.period === 'today') {
    from = startOfDay(now);
  } else if (q.period === '30d') {
    from = addDays(now, -30);
  } else if (q.period === '7d') {
    from = addDays(now, -7);
  } else {
    from = addDays(now, -30);
  }
  // An explicit `from` far in the past would otherwise force an unbounded aggregation
  // scan over the whole collection — cap the window instead of trusting client input.
  const MAX_RANGE_DAYS = 400;
  const minFrom = addDays(to, -MAX_RANGE_DAYS);
  if (from < minFrom) from = minFrom;
  return { from, to };
}
