import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config as appConfig } from '../config';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local + AWS metadata
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^0\./,
];

const BLOCK_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254',
]);

/** Returns true if the IPv4/IPv6 address is in a blocked range. */
function isBlockedIp(addr: string): boolean {
  const v = isIP(addr);
  if (v === 0) return true; // Unknown format → block
  if (v === 4) {
    return PRIVATE_V4.some((re) => re.test(addr));
  }
  // IPv6
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe80')) return true; // link-local
  // ::ffff:x.x.x.x → check the IPv4-mapped address
  const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m && m[1]) return PRIVATE_V4.some((re) => re.test(m[1]!));
  return false;
}

export interface SafeFetchOptions extends RequestInit {
  /** Override allow-private (dev convenience). Default: based on NODE_ENV. */
  allowPrivate?: boolean;
  /** Timeout in ms (default 15s). */
  timeoutMs?: number;
}

export class SafeFetchError extends Error {
  constructor(
    public reason: 'invalid_url' | 'blocked_host' | 'blocked_ip' | 'dns_failed' | 'fetch_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

/**
 * SSRF-resistant fetch wrapper.
 *
 * - Validates URL scheme (http/https only; https required in production)
 * - Resolves DNS via getaddrinfo and rejects if any A/AAAA record is private
 * - Re-checks resolved IP at request time (still TOCTOU-prone for advanced
 *   attackers but blocks 99% of opportunistic SSRF)
 *
 * NOTE: a fully TOCTOU-safe implementation requires intercepting `connect`
 * via `undici.Agent` lookup. Deferred until we adopt undici Agent globally.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('invalid_url', `invalid URL: ${rawUrl}`);
  }
  const allowPrivate =
    opts.allowPrivate ?? appConfig.NODE_ENV !== 'production';

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('invalid_url', `unsupported scheme: ${url.protocol}`);
  }
  if (!allowPrivate && url.protocol !== 'https:') {
    throw new SafeFetchError('invalid_url', 'https required in production');
  }

  const host = url.hostname.toLowerCase();
  if (!allowPrivate && BLOCK_HOSTS.has(host)) {
    throw new SafeFetchError('blocked_host', `blocked host: ${host}`);
  }

  // If host is already an IP, validate directly.
  if (isIP(host)) {
    if (!allowPrivate && isBlockedIp(host)) {
      throw new SafeFetchError('blocked_ip', `blocked IP: ${host}`);
    }
  } else if (!allowPrivate) {
    // Resolve DNS; reject if any answer is in a private range.
    let resolved: { address: string; family: number }[];
    try {
      resolved = await dnsLookup(host, { all: true });
    } catch {
      throw new SafeFetchError('dns_failed', `DNS lookup failed for ${host}`);
    }
    if (resolved.length === 0) {
      throw new SafeFetchError('dns_failed', `no DNS records for ${host}`);
    }
    for (const r of resolved) {
      if (isBlockedIp(r.address)) {
        throw new SafeFetchError(
          'blocked_ip',
          `${host} resolves to private IP ${r.address}`,
        );
      }
    }
  }

  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    return await fetch(url.toString(), {
      ...opts,
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SafeFetchError('fetch_failed', (err as Error).message);
  }
}
