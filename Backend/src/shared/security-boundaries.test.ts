import { it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { isPublicHttpUrl } from './url-security';
import { protectCookieMutation, redactRequestUrl } from './request-origin';
import { parseAnalyticsRange } from '../modules/analytics/date-range';

afterEach(() => vi.unstubAllEnvs());
it.each(['http://[::ffff:127.0.0.1]', 'http://[::ffff:7f00:1]', 'http://[fe90::1]', 'http://[2002:7f00:1::]', 'http://169.254.169.254', 'http://2130706433', 'file:///etc/passwd', 'http://[64:ff9b::7f00:1]'])('blocks private/transition URL %s', (url) => expect(isPublicHttpUrl(url)).toBe(false));
it.each(['https://[2001:4860:4860::8888]', 'https://[2606:4700:4700::1111]', 'https://example.com/media'])('allows public URL %s', (url) => expect(isPublicHttpUrl(url)).toBe(true));
it('blocks cookie CSRF before handlers while preserving explicit non-browser authentication', async () => {
  vi.stubEnv('CORS_ORIGIN', 'https://app.example.test');
  const app = Fastify(); await app.register(cookie); app.addHook('onRequest', protectCookieMutation);
  const handler = vi.fn(async () => ({ ok: true })); app.post('/api/items', handler); app.post('/api/auth/login', handler);
  for (const origin of [undefined, 'null', 'https://evil.test']) {
    const result = await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: 'ww_access=token', ...(origin ? { origin } : {}) } });
    expect(result.statusCode).toBe(403);
  }
  expect(handler).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: 'ww_access=token', origin: 'https://app.example.test' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/items', headers: { authorization: 'Bearer explicit-client' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.test' } })).statusCode).toBe(403);
  await app.close();
});
it('removes bearer capabilities from access-log paths', () => {
  for (const url of ['/api/webhooks/in/secret?token=another', '/api/auth/avatar/id/secret', '/api/flow-assets/id/secret']) expect(redactRequestUrl(url)).not.toContain('secret');
});
it.each([{ from: 'bad', to: '2026-09-24' }, { from: '2026-09-24' }, { from: '2026-09-25', to: '2026-09-24' }, { from: '2026-09-24', to: '2999-01-01' }, { from: '2000-01-01', to: '2026-09-24' }])('rejects unbounded or invalid analytics interval %j', q => expect(() => parseAnalyticsRange(q, new Date('2026-09-24T12:00:00Z'))).toThrow());
it('keeps the supported analytics period', () => expect(parseAnalyticsRange({ period: '30d' }, new Date('2026-09-24T12:00:00Z')).from.toISOString()).toBe('2026-08-25T12:00:00.000Z'));
