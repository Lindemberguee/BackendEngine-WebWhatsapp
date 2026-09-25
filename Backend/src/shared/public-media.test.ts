import { it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(), options: {} as any }));
vi.mock('undici', () => ({ Agent: class { constructor(options: unknown) { mocks.options = options; } }, fetch: mocks.fetch }));
vi.mock('dns/promises', () => ({ lookup: mocks.lookup }));
import { fetchPublicUrl } from './public-fetch';
import { downloadPublicMedia, preparePublicMedia } from './public-media';
beforeEach(() => { mocks.fetch.mockReset(); mocks.lookup.mockReset(); });
it('rejects literal private destinations without invoking HTTP and forces manual redirects', async () => {
  expect(() => fetchPublicUrl('http://[::ffff:127.0.0.1]/')).toThrow(); expect(mocks.fetch).not.toHaveBeenCalled();
  mocks.fetch.mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://127.0.0.1' } }));
  await expect(downloadPublicMedia('https://public.example/file')).rejects.toThrow();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.fetch.mock.calls[0][1].redirect).toBe('manual');
});
it('honors Node lookup all and rejects mixed public/private DNS answers', async () => {
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  const result = await new Promise<unknown[]>((resolve) => mocks.options.connect.lookup('public.example', { all: true }, (...args: unknown[]) => resolve(args)));
  expect(result).toEqual([null, [{ address: '1.1.1.1', family: 4 }]]);
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const denied = await new Promise<unknown[]>((resolve) => mocks.options.connect.lookup('rebind.example', {}, (...args: unknown[]) => resolve(args)));
  expect(denied[0]).toBeInstanceOf(Error);
});
it('delivers bytes rather than remote URLs for media and carousel headers', async () => {
  mocks.fetch.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  const result = await preparePublicMedia({ image: { url: 'https://public.example/a' }, cards: [{ image: { url: 'https://public.example/b' } }] } as never) as any;
  expect(Buffer.isBuffer(result.image)).toBe(true); expect(Buffer.isBuffer(result.cards[0].image)).toBe(true);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  await expect(preparePublicMedia({ image: '/etc/passwd' } as never)).rejects.toThrow();
});
it('rejects oversized media before buffering the response', async () => {
  mocks.fetch.mockResolvedValue(new Response('x', { headers: { 'content-length': String(26 * 1024 * 1024) } }));
  await expect(downloadPublicMedia('https://public.example/huge')).rejects.toThrow('25 MB');
});
