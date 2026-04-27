import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Storage, type Bucket } from '@google-cloud/storage';

export type UploadResult = {
  url: string;
  key: string;
};

const isProd = process.env.NODE_ENV === 'production';
const bucketName = process.env.GCS_BUCKET_NAME;
// Optional prefix appended before "uploads/" — used when sharing a bucket
// with another app (e.g. GCS_PATH_PREFIX=axis writes to tenetimages/axis/uploads/...).
const pathPrefix = process.env.GCS_PATH_PREFIX?.replace(/^\/|\/$/g, '') ?? '';

let cachedBucket: Bucket | null = null;

function parseCredentials(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
      throw new Error('missing client_email or private_key');
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS_JSON is invalid (length=${raw.length}, ` +
        `starts with="${raw.slice(0, 16)}"): ${msg}`,
    );
  }
}

function getBucket(): Bucket {
  if (cachedBucket) return cachedBucket;
  if (!bucketName) {
    throw new Error('GCS_BUCKET_NAME is required in production');
  }

  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const storage = credsJson
    ? new Storage({ credentials: parseCredentials(credsJson) })
    : new Storage();

  cachedBucket = storage.bucket(bucketName);
  return cachedBucket;
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

async function uploadGcs(buffer: Buffer, key: string, contentType: string): Promise<UploadResult> {
  const objectKey = pathPrefix ? `${pathPrefix}/uploads/${key}` : `uploads/${key}`;
  const file = getBucket().file(objectKey);
  await file.save(buffer, {
    contentType,
    // private = no shared CDN cache (deletion takes effect immediately).
    // Short TTL keeps the client fast without making revocation impossible.
    metadata: { cacheControl: 'private, max-age=3600' },
    resumable: false,
  });
  return {
    url: `https://storage.googleapis.com/${bucketName}/${encodePath(objectKey)}`,
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
  if (isProd || bucketName) return uploadGcs(buffer, key, contentType);
  return uploadLocal(buffer, key);
}

export function isGcsEnabled(): boolean {
  return Boolean(bucketName);
}
