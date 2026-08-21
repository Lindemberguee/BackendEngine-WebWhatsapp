import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile, unlink } from 'fs/promises';
import path from 'path';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Message } from '../db/models';

export type MediaStorageProvider = 'local' | 's3';

export interface MediaStorageStatus {
  provider: MediaStorageProvider;
  service: 'local' | 'cloudflare-r2' | 's3-compatible';
  configured: boolean;
  bucket?: string;
  region?: string;
}

export interface MediaStorageDiagnostic extends MediaStorageStatus {
  reachable: boolean;
  latencyMs?: number;
  checkedAt: string;
  errorCode?: 'not_configured' | 'access_denied' | 'bucket_not_found' | 'timeout' | 'unavailable';
}

function provider(): MediaStorageProvider {
  return process.env.MEDIA_STORAGE_DRIVER === 's3' ? 's3' : 'local';
}

function localRoot(): string {
  return path.resolve(process.env.MEDIA_LOCAL_DIR || path.join(process.cwd(), 'data', 'media'));
}

export function resolveS3StorageConfig() {
  const bucket = process.env.MEDIA_S3_BUCKET?.trim();
  const region = process.env.MEDIA_S3_REGION || 'auto';
  const r2AccountId = process.env.MEDIA_R2_ACCOUNT_ID?.trim();
  const endpoint = process.env.MEDIA_S3_ENDPOINT?.trim()
    || (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : undefined);
  const accessKeyId = process.env.MEDIA_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.MEDIA_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket) throw new Error('MEDIA_S3_BUCKET é obrigatório quando MEDIA_STORAGE_DRIVER=s3');
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new Error('MEDIA_S3_ACCESS_KEY_ID e MEDIA_S3_SECRET_ACCESS_KEY devem ser configurados juntos');
  }
  if ((r2AccountId || endpoint?.includes('.r2.cloudflarestorage.com')) && (!accessKeyId || !secretAccessKey)) {
    throw new Error('As credenciais S3 do Cloudflare R2 são obrigatórias');
  }

  return { bucket, region, endpoint, accessKeyId, secretAccessKey };
}

export function validateMediaStorageConfig(): void {
  if (provider() === 's3') resolveS3StorageConfig();
}

export function describeMediaStorage(): MediaStorageStatus {
  const selected = provider();
  if (selected === 'local') return { provider: selected, service: 'local', configured: true };

  const endpoint = process.env.MEDIA_S3_ENDPOINT?.trim();
  const isR2 = Boolean(process.env.MEDIA_R2_ACCOUNT_ID?.trim() || endpoint?.includes('.r2.cloudflarestorage.com'));
  try {
    const config = resolveS3StorageConfig();
    return {
      provider: selected,
      service: isR2 ? 'cloudflare-r2' : 's3-compatible',
      configured: true,
      bucket: config.bucket,
      region: config.region,
    };
  } catch {
    return {
      provider: selected,
      service: isR2 ? 'cloudflare-r2' : 's3-compatible',
      configured: false,
      bucket: process.env.MEDIA_S3_BUCKET?.trim() || undefined,
      region: process.env.MEDIA_S3_REGION?.trim() || 'auto',
    };
  }
}

function s3Config() {
  const { bucket, region, endpoint, accessKeyId, secretAccessKey } = resolveS3StorageConfig();
  return {
    bucket,
    client: new S3Client({
      region,
      endpoint,
      forcePathStyle: process.env.MEDIA_S3_FORCE_PATH_STYLE === 'true',
      credentials: accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
    }),
  };
}

function extension(fileName?: string): string {
  const ext = path.extname(fileName || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ext.slice(0, 12);
}

export async function storeMedia(params: { workspaceId: string; buffer: Buffer; mimeType: string; fileName?: string }): Promise<{ key: string; provider: MediaStorageProvider; sha256: string }> {
  const selected = provider();
  const key = `${params.workspaceId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${extension(params.fileName)}`;
  if (selected === 's3') {
    const { client, bucket } = s3Config();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: params.buffer, ContentType: params.mimeType, Metadata: { sha256: createHash('sha256').update(params.buffer).digest('hex') } }));
  } else {
    const target = path.join(localRoot(), ...key.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, params.buffer, { flag: 'wx' });
  }
  return { key, provider: selected, sha256: createHash('sha256').update(params.buffer).digest('hex') };
}

export async function readMedia(key: string, storedProvider: MediaStorageProvider): Promise<Buffer> {
  if (storedProvider === 's3') {
    const { client, bucket } = s3Config();
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error('Objeto de mídia vazio');
    return Buffer.from(await result.Body.transformToByteArray());
  }
  return readFile(path.join(localRoot(), ...key.split('/')));
}

export async function deleteMedia(key: string, storedProvider: MediaStorageProvider): Promise<void> {
  if (storedProvider === 's3') {
    const { client, bucket } = s3Config();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } else {
    await unlink(path.join(localRoot(), ...key.split('/'))).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
  }
}

function diagnosticErrorCode(error: unknown): MediaStorageDiagnostic['errorCode'] {
  const candidate = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const code = `${candidate?.name ?? ''} ${candidate?.Code ?? ''} ${candidate?.code ?? ''}`.toLowerCase();
  const status = candidate?.$metadata?.httpStatusCode;
  if (status === 401 || status === 403 || code.includes('accessdenied') || code.includes('credentials')) return 'access_denied';
  if (status === 404 || code.includes('nosuchbucket') || code.includes('notfound')) return 'bucket_not_found';
  if (code.includes('timeout') || code.includes('abort')) return 'timeout';
  return 'unavailable';
}

export async function testMediaStorageConnection(): Promise<MediaStorageDiagnostic> {
  const status = describeMediaStorage();
  const checkedAt = new Date().toISOString();
  if (!status.configured) return { ...status, reachable: false, checkedAt, errorCode: 'not_configured' };

  const startedAt = Date.now();
  const payload = Buffer.from(`zapzin-storage-check:${randomUUID()}`, 'utf8');
  let stored: { key: string; provider: MediaStorageProvider } | undefined;
  try {
    stored = await storeMedia({ workspaceId: '_system-storage-check', buffer: payload, mimeType: 'text/plain', fileName: 'check.txt' });
    const restored = await readMedia(stored.key, stored.provider);
    if (!restored.equals(payload)) throw new Error('StorageIntegrityCheckFailed');
    await deleteMedia(stored.key, stored.provider);
    stored = undefined;
    return { ...status, reachable: true, latencyMs: Date.now() - startedAt, checkedAt };
  } catch (error) {
    return { ...status, reachable: false, latencyMs: Date.now() - startedAt, checkedAt, errorCode: diagnosticErrorCode(error) };
  } finally {
    if (stored) await deleteMedia(stored.key, stored.provider).catch(() => undefined);
  }
}

export async function archiveMessageMedia(messageId: string, workspaceId: string, buffer: Buffer, mimeType: string, fileName?: string): Promise<void> {
  const message = await Message.findOne({ _id: messageId, workspaceId }).select('mediaStorage').lean();
  if (!message || message.mediaStorage?.key) return;
  const stored = await storeMedia({ workspaceId, buffer, mimeType, fileName });
  const result = await Message.updateOne({ _id: messageId, workspaceId, 'mediaStorage.key': { $exists: false } }, { $set: { mediaStorage: { ...stored, mimeType, fileName, size: buffer.length, archivedAt: new Date() } } });
  if (result.modifiedCount === 0) await deleteMedia(stored.key, stored.provider);
}
