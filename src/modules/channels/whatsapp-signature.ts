import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio webhook signature verification.
 *
 * Algorithm (public, documented at
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security):
 *   base64( HMAC-SHA1( authToken,
 *     fullUrl + sort(keys).map(k => k + params[k]).join('') ) )
 *
 * The URL MUST be the exact URL Twilio called (including query string if any),
 * which requires trusting `X-Forwarded-Proto`/`X-Forwarded-Host` when behind a
 * proxy. Fastify with `trustProxy: true` already reflects those in `req.url`.
 *
 * Compares via timingSafeEqual to avoid signature-timing side channels.
 */
/** Accept string or string[] (repeated keys). Repeated values are concatenated
 * in document order as separate entries — Twilio's algorithm includes every
 * occurrence, not just the last. */
export type TwilioParams = Record<string, string | string[]>;

export function twilioSignature(
  authToken: string,
  fullUrl: string,
  params: TwilioParams,
): string {
  const sortedKeys = Object.keys(params).sort();
  const concat = sortedKeys
    .flatMap((k) => {
      const v = params[k];
      if (Array.isArray(v)) return v.map((vv) => `${k}${vv}`);
      return [`${k}${v ?? ''}`];
    })
    .join('');
  return createHmac('sha1', authToken).update(fullUrl + concat).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: TwilioParams,
  signatureHeader: string | undefined | string[],
): boolean {
  if (!signatureHeader || Array.isArray(signatureHeader)) return false;
  const expected = twilioSignature(authToken, fullUrl, params);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
