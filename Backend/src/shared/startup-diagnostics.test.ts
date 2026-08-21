import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMetaIntegration, checkStorageIntegration } from './startup-diagnostics';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe('startup diagnostics', () => {
  it('reports the exact variables missing to enable R2', async () => {
    process.env.MEDIA_STORAGE_DRIVER = 's3';
    delete process.env.MEDIA_S3_BUCKET;
    delete process.env.MEDIA_S3_ACCESS_KEY_ID;
    delete process.env.MEDIA_S3_SECRET_ACCESS_KEY;
    delete process.env.MEDIA_R2_ACCOUNT_ID;
    delete process.env.MEDIA_S3_ENDPOINT;

    const result = await checkStorageIntegration();

    expect(result.status).toBe('error');
    expect(result.missing).toEqual([
      'MEDIA_S3_BUCKET',
      'MEDIA_S3_ACCESS_KEY_ID',
      'MEDIA_S3_SECRET_ACCESS_KEY',
      'MEDIA_R2_ACCOUNT_ID ou MEDIA_S3_ENDPOINT',
    ]);
  });

  it('reports a successful storage round-trip without exposing credentials', async () => {
    process.env.MEDIA_STORAGE_DRIVER = 's3';
    process.env.MEDIA_S3_BUCKET = 'media';
    process.env.MEDIA_R2_ACCOUNT_ID = 'account';
    process.env.MEDIA_S3_ACCESS_KEY_ID = 'access';
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = 'secret';

    const result = await checkStorageIntegration(async () => ({
      provider: 's3',
      service: 'cloudflare-r2',
      configured: true,
      bucket: 'media',
      region: 'auto',
      reachable: true,
      latencyMs: 42,
      checkedAt: new Date().toISOString(),
    }));

    expect(result).toMatchObject({ status: 'connected', latencyMs: 42 });
    expect(JSON.stringify(result)).not.toContain('access');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('validates the Meta app and warns when Embedded Signup is missing', async () => {
    process.env.META_APP_ID = '123';
    process.env.META_APP_SECRET = 'top-secret';
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify';
    delete process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer 123|top-secret' });
      return new Response(JSON.stringify({ id: '123', name: 'Zapzin' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await checkMetaIntegration(fetchMock);

    expect(result).toMatchObject({ status: 'warning', missing: ['META_EMBEDDED_SIGNUP_CONFIG_ID'] });
    expect(JSON.stringify(result)).not.toContain('top-secret');
  });

  it('does not call Meta when required configuration is missing', async () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify';
    const fetchMock = vi.fn() as typeof fetch;

    const result = await checkMetaIntegration(fetchMock);

    expect(result.status).toBe('warning');
    expect(result.missing).toEqual(['META_APP_ID', 'META_APP_SECRET']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
