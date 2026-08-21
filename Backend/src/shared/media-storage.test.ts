import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { deleteMedia, describeMediaStorage, readMedia, resolveS3StorageConfig, storeMedia, testMediaStorageConnection, validateMediaStorageConfig } from './media-storage';

describe('media storage (local)', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    delete process.env.MEDIA_LOCAL_DIR;
    delete process.env.MEDIA_STORAGE_DRIVER;
    delete process.env.MEDIA_R2_ACCOUNT_ID;
    delete process.env.MEDIA_S3_BUCKET;
    delete process.env.MEDIA_S3_REGION;
    delete process.env.MEDIA_S3_ENDPOINT;
    delete process.env.MEDIA_S3_ACCESS_KEY_ID;
    delete process.env.MEDIA_S3_SECRET_ACCESS_KEY;
  });

  it('stores, reads and deletes media without exposing the original filename in the key', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'zapzin-media-'));
    process.env.MEDIA_STORAGE_DRIVER = 'local';
    process.env.MEDIA_LOCAL_DIR = directory;
    const source = Buffer.from('permanent-media');
    const stored = await storeMedia({ workspaceId: 'workspace-1', buffer: source, mimeType: 'image/png', fileName: '../../private.png' });
    expect(stored.key).toMatch(/^workspace-1\/\d{4}-\d{2}\/[a-f0-9-]+\.png$/);
    expect(await readMedia(stored.key, stored.provider)).toEqual(source);
    await deleteMedia(stored.key, stored.provider);
    await expect(readMedia(stored.key, stored.provider)).rejects.toThrow();
  });

  it('derives the Cloudflare R2 endpoint from the account ID', () => {
    process.env.MEDIA_STORAGE_DRIVER = 's3';
    process.env.MEDIA_R2_ACCOUNT_ID = 'account-123';
    process.env.MEDIA_S3_BUCKET = 'private-media';
    process.env.MEDIA_S3_ACCESS_KEY_ID = 'access-key';
    process.env.MEDIA_S3_SECRET_ACCESS_KEY = 'secret-key';

    expect(resolveS3StorageConfig()).toMatchObject({
      bucket: 'private-media',
      region: 'auto',
      endpoint: 'https://account-123.r2.cloudflarestorage.com',
    });
    expect(() => validateMediaStorageConfig()).not.toThrow();
  });

  it('rejects incomplete Cloudflare R2 credentials during startup validation', () => {
    process.env.MEDIA_STORAGE_DRIVER = 's3';
    process.env.MEDIA_R2_ACCOUNT_ID = 'account-123';
    process.env.MEDIA_S3_BUCKET = 'private-media';
    process.env.MEDIA_S3_ACCESS_KEY_ID = 'access-key';

    expect(() => validateMediaStorageConfig()).toThrow('MEDIA_S3_ACCESS_KEY_ID e MEDIA_S3_SECRET_ACCESS_KEY');
  });

  it('checks write, read and deletion using the configured storage provider', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'zapzin-media-check-'));
    process.env.MEDIA_STORAGE_DRIVER = 'local';
    process.env.MEDIA_LOCAL_DIR = directory;

    expect(describeMediaStorage()).toMatchObject({ provider: 'local', service: 'local', configured: true });
    await expect(testMediaStorageConnection()).resolves.toMatchObject({
      provider: 'local',
      configured: true,
      reachable: true,
    });
  });
});
