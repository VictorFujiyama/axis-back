import { createHmac } from 'node:crypto';
import { config } from '../../../config.js';

export type StatePayload = {
  accountId: string;
  userId: string;
  inboxName: string;
  inboxId?: string | null;
  nonce: string;
  ts: number;
};

/**
 * OAuth state token. Signs `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`
 * using `JWT_SECRET`. The HMAC covers the encoded payload string so verifyState
 * can recompute it from the wire form without re-canonicalizing JSON.
 */
export function signState(payload: StatePayload): string {
  const json = JSON.stringify(payload);
  const payloadB64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = createHmac('sha256', config.JWT_SECRET)
    .update(payloadB64)
    .digest()
    .toString('base64url');
  return `${payloadB64}.${sig}`;
}
