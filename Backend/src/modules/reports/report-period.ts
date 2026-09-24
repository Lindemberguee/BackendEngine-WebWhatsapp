import { resolveDateRange } from '../../shared/date-range';

const formatter = new Intl.DateTimeFormat('en', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function dateParts(date: Date) {
  const parts = formatter.formatToParts(date);
  return (type: string) => parts.find((part) => part.type === type)!.value;
}

export function reportDay(date: Date): string {
  const part = dateParts(date);
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Excel dates have no timezone: preserve the displayed Sao Paulo wall-clock time.
export function reportExcelDate(date: Date): Date {
  const part = dateParts(date);
  return new Date(`${reportDay(date)}T${part('hour')}:${part('minute')}:${part('second')}.000Z`);
}

export function reportRange(query: Record<string, string>): { from: Date; to: Date } {
  const badRequest = () => Object.assign(new Error('Filtros de relatorio invalidos.'), { statusCode: 400 });
  const q = { ...query };
  for (const key of ['from', 'to', 'agentId', 'teamGroupId']) {
    if (q[key] !== undefined && typeof q[key] !== 'string') throw badRequest();
  }
  for (const key of ['agentId', 'teamGroupId']) {
    if (q[key] && !/^[a-f\d]{24}$/i.test(q[key])) throw badRequest();
  }
  for (const key of ['from', 'to']) {
    if (q[key] === undefined) continue;
    const value = q[key];
    const day = value.slice(0, 10);
    const parsed = new Date(day);
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$)/.test(value)
      || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw badRequest();
    if (value.length === 10) q[key] = `${value}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}-03:00`;
    if (!Number.isFinite(new Date(q[key]).getTime())) throw badRequest();
  }
  if (q.from && q.to && new Date(q.from) > new Date(q.to)) throw badRequest();
  const range = resolveDateRange(q);
  if (range.from > range.to) throw badRequest();
  return range;
}
