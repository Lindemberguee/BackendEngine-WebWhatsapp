const DAY = 86400_000;
export function parseAnalyticsRange(q: { from?: string; to?: string; period?: string }, now = new Date()) {
  if (Boolean(q.from) !== Boolean(q.to)) throw new Error('Informe as duas datas');
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : q.period === 'today'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(now.getTime() - (q.period === '30d' ? 30 : 7) * DAY);
  const endOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - 1;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to || to.getTime() > endOfToday || to.getTime() - from.getTime() > 366 * DAY) throw new Error('Período inválido: máximo de 366 dias, sem datas futuras');
  return { from, to };
}
