// Several list routes read `page`/`limit` straight from the query string and pass
// them to `.skip()/.limit()` uncapped — a client asking for `limit=999999` (or a
// huge `page`, which turns into a huge `.skip()` the index still has to walk past)
// got exactly that: the full collection, unbounded, with no server-side ceiling.
// Clamp both to sane bounds at the one place every route already reads them from.
export function parsePagination(
  query: Record<string, string | undefined>,
  defaults: { limit?: number; maxLimit?: number } = {}
): { page: number; limit: number; skip: number } {
  const defaultLimit = defaults.limit ?? 20;
  const maxLimit = defaults.maxLimit ?? 100;
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}
