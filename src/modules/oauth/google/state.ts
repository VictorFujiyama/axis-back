import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../../config.js';

export type StatePayload = {
  accountId: string;
  userId: string;
  inboxName: string;
  inboxId?: string | null;
  nonce: string;
  ts: number;
};

const STATE_TTL_MS = 10 * 60 * 1000;

export class InvalidStateError extends Error {
  constructor(message = 'invalid state') {
    super(message);
    this.name = 'InvalidStateError';
  }
}

export class ExpiredStateError extends Error {
  constructor(message = 'expired state') {
    super(message);
    this.name = 'ExpiredStateError';
  }
}

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

export function verifyState(stateStr: string): StatePayload {
  const parts = stateStr.split('.');
  if (parts.length !== 2) throw new InvalidStateError();
  const [payloadB64, sig] = parts as [string, string];

  const expected = createHmac('sha256', config.JWT_SECRET)
    .update(payloadB64)
    .digest()
    .toString('base64url');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidStateError();
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as StatePayload;
  } catch {
    throw new InvalidStateError();
  }

  if (typeof payload?.ts !== 'number') throw new InvalidStateError();
  if (Date.now() - payload.ts > STATE_TTL_MS) throw new ExpiredStateError();

  return payload;
}
