import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe-style signed payload header.
 *   X-Blossom-Signature: t=<unix_seconds>,v1=<hex hmac-sha256(t.body)>
 *
 * Including the timestamp in the signed string prevents replay — a recipient
 * verifies that `now - t < tolerance` (default 5min) before trusting v1.
 */
export function signOutboundPayload(body: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const signed = `${t}.${body}`;
  const v1 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Verify — useful in tests and for documenting the recipient contract. */
export function verifyOutboundSignature(
  header: string,
  body: string,
  secret: string,
  toleranceSec = 5 * 60,
  now = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k ?? '', v ?? ''];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const ageSec = Math.abs(Math.floor(now / 1000) - t);
  if (ageSec > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
