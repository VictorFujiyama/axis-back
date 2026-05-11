import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import { config } from '../../config';

export type PlaybookSource = 'atlas-fresh' | 'atlas-cached' | 'atlas-304';

export interface PlaybookFetcherApp {
  redis: Redis;
  log: FastifyBaseLogger;
}

export interface PlaybookFetcherDeps {
  fetchImpl?: typeof fetch;
}

export interface PlaybookFetchResult {
  markdown: string;
  source: PlaybookSource;
  etag: string;
}

const CACHE_TTL_S = 300;
const CACHE_TTL_MS = CACHE_TTL_S * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface CacheEntry {
  etag: string;
  markdown: string;
  fetchedAt: number;
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['etag'] === 'string' &&
    typeof o['markdown'] === 'string' &&
    typeof o['fetchedAt'] === 'number'
  );
}

function cacheKey(inboxId: string): string {
  return `axis:playbook:${inboxId}`;
}

export async function fetchPlaybook(
  inboxId: string,
  app: PlaybookFetcherApp,
  deps?: PlaybookFetcherDeps,
): Promise<PlaybookFetchResult | null> {
  const baseUrl = config.ATLAS_BASE_URL;
  const apiKey = config.ATLAS_API_KEY;
  // Intentional silent no-op when the integration is off: avoids log spam
  // on every bot turn in envs that simply don't have Atlas configured.
  if (!baseUrl || !apiKey) return null;

  const key = cacheKey(inboxId);
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;

  let cache: CacheEntry | null = null;
  const raw = await app.redis.get(key);
  if (raw !== null) {
    let parsed: unknown;
    let parseErr: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseErr = err;
    }
    if (parseErr !== undefined || !isCacheEntry(parsed)) {
      await app.redis.del(key);
      app.log.warn(
        { key, ...(parseErr !== undefined ? { err: parseErr } : {}) },
        'corrupted playbook cache, evicted',
      );
    } else {
      cache = parsed;
    }
  }

  const now = Date.now();
  if (
    cache &&
    cache.fetchedAt <= now &&
    now - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return { markdown: cache.markdown, source: 'atlas-cached', etag: cache.etag };
  }

  const url = `${baseUrl}/api/messaging/playbook/${inboxId}`;
  const headers: Record<string, string> = { 'X-API-Key': apiKey };
  if (cache) headers['If-None-Match'] = `"${cache.etag}"`;

  const fetchStart = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    app.log.warn(
      { inboxId, err, durationMs: Date.now() - fetchStart },
      'playbook fetch failed',
    );
    return null;
  }

  if (response.status === 304 && cache) {
    const renewed: CacheEntry = {
      etag: cache.etag,
      markdown: cache.markdown,
      fetchedAt: Date.now(),
    };
    await app.redis.set(key, JSON.stringify(renewed), 'EX', CACHE_TTL_S);
    return { markdown: cache.markdown, source: 'atlas-304', etag: cache.etag };
  }

  if (response.status === 200) {
    const etag = (response.headers.get('etag') ?? '').replace(/^"|"$/g, '');
    const markdown = await response.text();
    const entry: CacheEntry = { etag, markdown, fetchedAt: Date.now() };
    await app.redis.set(key, JSON.stringify(entry), 'EX', CACHE_TTL_S);
    return { markdown, source: 'atlas-fresh', etag };
  }

  app.log.warn(
    { inboxId, status: response.status, durationMs: Date.now() - fetchStart },
    'playbook fetch failed',
  );
  return null;
}
