import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config';

// Derive a deterministic 32-byte key from ENCRYPTION_KEY.
// Accepts 64 hex chars (direct) or any string (sha256 derivation).
function deriveKey(secret: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex');
  return createHash('sha256').update(secret).digest();
}

const KEY = deriveKey(config.ENCRYPTION_KEY);
const VERSION = 'v1';

/**
 * Encrypts an arbitrary JSON-serializable value using AES-256-GCM.
 * Output format: `v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 */
export function encryptJSON(data: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptJSON<T = unknown>(blob: string): T {
  const parts = blob.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted blob');
  const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  if (version !== VERSION) throw new Error(`Unsupported cipher version: ${version}`);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison via SHA-256 digest — prevents timing leaks
 * and works for inputs of different lengths.
 */
export function constantTimeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
