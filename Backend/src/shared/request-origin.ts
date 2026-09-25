import type { FastifyRequest, FastifyReply } from 'fastify';
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false;
  const allowed = (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean);
  return allowed.includes(origin);
}
export async function protectCookieMutation(request: FastifyRequest, reply: FastifyReply) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const path = request.url.split('?')[0].replace(/\/$/, '');
  const sessionEndpoint = /^\/api\/auth\/(login|register|refresh|logout)$/.test(path);
  const hasCookies = Boolean(request.cookies.ww_access || request.cookies.ww_refresh);
  const explicitBearer = request.headers.authorization?.startsWith('Bearer ');
  if ((sessionEndpoint || (hasCookies && !explicitBearer)) && !isAllowedOrigin(request.headers.origin)) {
    return reply.status(403).send({ error: 'Origem da requisição não permitida' });
  }
}
export function redactRequestUrl(url: string): string {
  return url.split('?')[0]
    .replace(/(\/api\/webhooks\/in\/)[^/]+/, '$1[redacted]')
    .replace(/(\/api\/(?:auth\/avatar|flow-assets)\/[^/]+\/)[^/]+/, '$1[redacted]');
}
