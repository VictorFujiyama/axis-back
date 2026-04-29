import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type Redis from 'ioredis';

export type UploadResult = {
  url: string;
  key: string;
};

/** Thrown when the monthly write budget is exhausted. Routes map this to 503. */
export class StorageQuotaExceeded extends Error {
  constructor(
    public used: number,
    public limit: number,
  ) {
    super(`Storage write budget exhausted (${used}/${limit} this month)`);
    this.name = 'StorageQuotaExceeded';
  }
}

const MONTHLY_WRITE_LIMIT = Number(process.env.STORAGE_MONTHLY_WRITE_LIMIT) || 500_000;
const WARN_THRESHOLD_RATIO = 0.8;
let warned = false;

const isProd = process.env.NODE_ENV === 'production';

// Cloudflare R2 (S3-compatible). Replaces the legacy GCS backend — same API
// shape (uploadFile/isStorageEnabled) so callers don't change.
const bucketName = process.env.R2_BUCKET_NAME;
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
// Public base URL for served objects (no trailing slash). Either the dev
// hostname (https://pub-<hash>.r2.dev) or a custom domain bound to the bucket.
const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '') ?? '';
// Optional prefix appended before "uploads/" — used when sharing a bucket
// with another app (e.g. R2_PATH_PREFIX=axis writes to <bucket>/axis/uploads/...).
const pathPrefix = process.env.R2_PATH_PREFIX?.replace(/^\/|\/$/g, '') ?? '';

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  if (!bucketName || !accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 storage requires R2_BUCKET_NAME, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY',
    );
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

const LOCAL_UPLOADS_DIR = join(import.meta.dirname, '..', '..', 'uploads');

async function uploadLocal(buffer: Buffer, key: string): Promise<UploadResult> {
  const dest = join(LOCAL_UPLOADS_DIR, key);
  await mkdir(dirname(dest), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(dest);
    ws.on('finish', resolve);
    ws.on('error', reject);
    ws.end(buffer);
  });
  return { url: `/uploads/${encodePath(key)}`, key };
}

async function uploadR2(buffer: Buffer, key: string, contentType: string): Promise<UploadResult> {
  const objectKey = pathPrefix ? `${pathPrefix}/uploads/${key}` : `uploads/${key}`;
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName!,
      Key: objectKey,
      Body: buffer,
      ContentType: contentType,
      // Short TTL on the public CDN so deletes propagate quickly without
      // killing performance.
      CacheControl: 'private, max-age=3600',
    }),
  );
  if (!publicUrl) {
    throw new Error('R2_PUBLIC_URL is required to serve uploaded objects');
  }
  return {
    url: `${publicUrl}/${encodePath(objectKey)}`,
    key: objectKey,
  };
}

/**
 * Upload a file under `key`. Caller is responsible for the path shape —
 * by convention `<accountId>/<uuid>.<ext>` so each tenant's files are
 * isolated and easy to audit, bill, or purge for LGPD requests.
 */
export async function uploadFile(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<UploadResult> {
  if (isProd || bucketName) return uploadR2(buffer, key, contentType);
  return uploadLocal(buffer, key);
}

export function isStorageEnabled(): boolean {
  return Boolean(bucketName);
}

/** @deprecated kept for backward compat with old callers; use isStorageEnabled. */
export const isGcsEnabled = isStorageEnabled;

/**
 * Defensive monthly cap on R2 writes (Class A operations). Increment-and-check
 * pattern: each upload reserves one slot before the actual PutObject. If the
 * monthly counter has already crossed the limit, throw and refuse the upload.
 *
 * Default budget is half the R2 free tier (1M ops/month). Override via env
 * STORAGE_MONTHLY_WRITE_LIMIT. Counter key auto-rolls over each calendar
 * month (UTC) and self-expires 35 days after first write.
 */
export async function reserveWriteSlot(redis: Redis): Promise<{ used: number; limit: number }> {
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `storage:writes:${yyyymm}`;

  const used = await redis.incr(key);
  // Set expiry only on first write of the month so we don't reset the TTL
  // every call. 35 days = covers any month length + safety margin.
  if (used === 1) {
    await redis.expire(key, 35 * 24 * 3600);
  }

  if (used > MONTHLY_WRITE_LIMIT) {
    // Roll back — caller didn't actually write.
    await redis.decr(key);
    throw new StorageQuotaExceeded(used - 1, MONTHLY_WRITE_LIMIT);
  }

  if (!warned && used >= MONTHLY_WRITE_LIMIT * WARN_THRESHOLD_RATIO) {
    warned = true;
    // Will surface in app logs on the route that calls this — caller can
    // also forward to its own logger if needed.
    console.warn(
      `[storage] write budget at ${used}/${MONTHLY_WRITE_LIMIT} (>=80%) — investigate before paid tier kicks in`,
    );
  }

  return { used, limit: MONTHLY_WRITE_LIMIT };
}
