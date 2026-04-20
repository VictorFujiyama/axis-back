/**
 * safeFetch — DNS-aware fetch that blocks SSRF via DNS rebinding.
 * Resolves the hostname first, checks the IP against private ranges,
 * then fetches. Prevents attackers from registering a domain that
 * initially resolves to a public IP (passes URL validation) but later
 * resolves to 127.0.0.1 / 169.254.169.254 / internal IPs.
 */
import { lookup } from 'node:dns/promises';
import { config } from '../../config';

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
];

const PRIVATE_IPV6 = [
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^::$/,
];

function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) {
    return PRIVATE_IPV6.some((re) => re.test(ip));
  }
  return PRIVATE_IPV4.some((re) => re.test(ip));
}

/**
 * Like fetch(), but resolves DNS first and blocks private IPs in production.
 * In development, all IPs are allowed (localhost bots are common).
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const isProd = config.NODE_ENV === 'production';
  if (isProd) {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Skip IP check for literal IPs that already passed isAllowedWebhookUrl
    // (which blocks private IPs at registration time), but still do the DNS
    // resolution check for hostnames that could be rebound.
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIP(address)) {
        throw new Error(
          `SSRF blocked: ${hostname} resolved to private IP ${address}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('SSRF blocked')) {
        throw err;
      }
      // DNS resolution failed — let fetch handle the error naturally
    }
  }

  return fetch(url, init);
}
