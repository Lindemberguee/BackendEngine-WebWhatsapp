export function pagination(query: unknown) {
  const q = query as { page?: unknown; limit?: unknown } | undefined;
  const page = Math.max(1, Math.min(100_000, Math.floor(Number(q?.page) || 1)));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(q?.limit) || 50)));
  return { page, limit, skip: (page - 1) * limit };
}
export const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, totalPages: Math.ceil(total / limit) });
