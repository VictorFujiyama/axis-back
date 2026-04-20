import { config } from '../../config';

const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

const PRIVATE_HOSTS = new Set(['localhost', '0.0.0.0', '::', '::1']);

/**
 * Returns true if the URL is acceptable for outbound webhook delivery.
 * In development we allow localhost; in production we block private ranges
 * and non-https schemes.
 */
export function isAllowedWebhookUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  const isProd = config.NODE_ENV === 'production';
  if (isProd && url.protocol !== 'https:') {
    return { ok: false, reason: 'https required in production' };
  }
  if (!isProd && url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'http or https required' };
  }
  const host = url.hostname.toLowerCase();
  if (isProd) {
    if (PRIVATE_HOSTS.has(host)) {
      return { ok: false, reason: 'private host not allowed' };
    }
    if (PRIVATE_RANGES.some((re) => re.test(host))) {
      return { ok: false, reason: 'private IP range not allowed' };
    }
  }
  return { ok: true };
}
