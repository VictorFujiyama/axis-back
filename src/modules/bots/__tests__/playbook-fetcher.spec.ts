import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';

type Fetcher = typeof import('../playbook-fetcher');

interface MockApp {
  redis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  log: {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

// Mirrors the internal CacheEntry shape — kept inline so a change to the
// real shape would force a deliberate edit here too.
interface CacheEntry {
  etag: string;
  markdown: string;
  fetchedAt: number;
}

const INBOX_ID = '00000000-0000-4000-8000-000000000001';
const CACHE_KEY = `axis:playbook:${INBOX_ID}`;
const BASE_URL = 'http://localhost:3010';
const API_KEY = 'test-api-key';
const EXPECTED_URL = `${BASE_URL}/api/messaging/playbook/${INBOX_ID}`;

// Reset modules + stub env, then re-import the fetcher so it picks up a fresh
// `config` snapshot. The real config is parsed once at module load — without
// resetModules the first import would freeze whatever env was visible then.
async function loadFetcher(
  env: { ATLAS_BASE_URL?: string | null; ATLAS_API_KEY?: string | null } = {},
): Promise<Fetcher> {
  vi.resetModules();
  if (env.ATLAS_BASE_URL === null) {
    vi.stubEnv('ATLAS_BASE_URL', '');
    delete process.env['ATLAS_BASE_URL'];
  } else {
    vi.stubEnv('ATLAS_BASE_URL', env.ATLAS_BASE_URL ?? BASE_URL);
  }
  if (env.ATLAS_API_KEY === null) {
    vi.stubEnv('ATLAS_API_KEY', '');
    delete process.env['ATLAS_API_KEY'];
  } else {
    vi.stubEnv('ATLAS_API_KEY', env.ATLAS_API_KEY ?? API_KEY);
  }
  return await import('../playbook-fetcher');
}

function makeMockApp(redisGet: string | null = null): MockApp {
  return {
    redis: {
      get: vi.fn().mockResolvedValue(redisGet),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    },
    log: { warn: vi.fn(), info: vi.fn() },
  };
}

function appAs(mock: MockApp): {
  redis: Redis;
  log: FastifyBaseLogger;
} {
  return {
    redis: mock.redis as unknown as Redis,
    log: mock.log as unknown as FastifyBaseLogger,
  };
}

function cacheJson(entry: CacheEntry): string {
  return JSON.stringify(entry);
}

describe('fetchPlaybook', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('(a) returns null without touching network when ATLAS_BASE_URL is undefined', async () => {
    const { fetchPlaybook } = await loadFetcher({ ATLAS_BASE_URL: null });
    const app = makeMockApp();
    const fetchImpl = vi.fn();

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // Step 1 of the spec short-circuits before reading Redis — no log spam either.
    expect(app.redis.get).not.toHaveBeenCalled();
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it('(b) returns cached result without fetching when cache is fresh', async () => {
    const entry: CacheEntry = {
      etag: 'cachedetag123456',
      markdown: 'cached-markdown',
      fetchedAt: Date.now() - 100_000,
    };
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(cacheJson(entry));
    const fetchImpl = vi.fn();

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(result).toEqual({
      markdown: 'cached-markdown',
      source: 'atlas-cached',
      etag: 'cachedetag123456',
    });
    expect(app.redis.get).toHaveBeenCalledWith(CACHE_KEY);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(app.redis.set).not.toHaveBeenCalled();
  });

  it('(c) refreshes via 200 with If-None-Match when cache is stale', async () => {
    const stale: CacheEntry = {
      etag: 'oldetag',
      markdown: 'old-markdown',
      fetchedAt: Date.now() - 400_000,
    };
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(cacheJson(stale));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('new-markdown', {
        status: 200,
        headers: { etag: '"newetag"' },
      }),
    );

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(EXPECTED_URL);
    expect(calledInit.headers['X-API-Key']).toBe(API_KEY);
    expect(calledInit.headers['If-None-Match']).toBe('"oldetag"');

    expect(app.redis.set).toHaveBeenCalledTimes(1);
    const [setKey, setVal, ex, ttl] = app.redis.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(setKey).toBe(CACHE_KEY);
    expect(ex).toBe('EX');
    expect(ttl).toBe(300);
    const written = JSON.parse(setVal) as CacheEntry;
    expect(written.etag).toBe('newetag');
    expect(written.markdown).toBe('new-markdown');
    expect(written.fetchedAt).toBeGreaterThan(stale.fetchedAt);

    expect(result).toEqual({
      markdown: 'new-markdown',
      source: 'atlas-fresh',
      etag: 'newetag',
    });
  });

  it('(d) renews TTL with same content on 304', async () => {
    const stale: CacheEntry = {
      etag: 'sameetag',
      markdown: 'same-markdown',
      fetchedAt: Date.now() - 400_000,
    };
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(cacheJson(stale));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 304 }));

    const before = Date.now();
    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });
    const after = Date.now();

    expect(result).toEqual({
      markdown: 'same-markdown',
      source: 'atlas-304',
      etag: 'sameetag',
    });
    expect(app.redis.set).toHaveBeenCalledTimes(1);
    const [setKey, setVal, ex, ttl] = app.redis.set.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(setKey).toBe(CACHE_KEY);
    expect(ex).toBe('EX');
    expect(ttl).toBe(300);
    const renewed = JSON.parse(setVal) as CacheEntry;
    expect(renewed.etag).toBe('sameetag');
    expect(renewed.markdown).toBe('same-markdown');
    // New fetchedAt is "now-ish", not the original stale timestamp.
    expect(renewed.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(renewed.fetchedAt).toBeLessThanOrEqual(after);
    expect(renewed.fetchedAt).toBeGreaterThan(stale.fetchedAt);
  });

  it('(e) fetches without If-None-Match when cache is empty, populates cache on 200', async () => {
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(null);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('fresh-markdown', {
        status: 200,
        headers: { etag: '"freshetag"' },
      }),
    );

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledInit = fetchImpl.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    expect(calledInit.headers['X-API-Key']).toBe(API_KEY);
    expect(calledInit.headers['If-None-Match']).toBeUndefined();

    expect(app.redis.set).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      app.redis.set.mock.calls[0]![1] as string,
    ) as CacheEntry;
    expect(written.etag).toBe('freshetag');
    expect(written.markdown).toBe('fresh-markdown');

    expect(result).toEqual({
      markdown: 'fresh-markdown',
      source: 'atlas-fresh',
      etag: 'freshetag',
    });
  });

  it('(f) returns null and logs warn on 404 with empty cache', async () => {
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(null);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404 }));

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(result).toBeNull();
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = app.log.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx['inboxId']).toBe(INBOX_ID);
    expect(ctx['status']).toBe(404);
    expect(msg).toBe('playbook fetch failed');
    expect(app.redis.set).not.toHaveBeenCalled();
  });

  it('(g) returns null and logs warn on AbortError (timeout)', async () => {
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(null);
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const fetchImpl = vi.fn().mockRejectedValue(abortErr);

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(result).toBeNull();
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = app.log.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx['inboxId']).toBe(INBOX_ID);
    expect(ctx['err']).toBe(abortErr);
    expect(msg).toBe('playbook fetch failed');
  });

  it('(h) evicts corrupted cache, then fetches as if empty', async () => {
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp('{not-json');
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('recovered-markdown', {
        status: 200,
        headers: { etag: '"recoveredetag"' },
      }),
    );

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(app.redis.del).toHaveBeenCalledWith(CACHE_KEY);
    // Corruption is logged with the eviction key, distinct from the
    // network-failure warn message.
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    expect(app.log.warn.mock.calls[0]![1]).toBe(
      'corrupted playbook cache, evicted',
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledInit = fetchImpl.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    // Cache was treated as empty post-eviction, so no conditional header.
    expect(calledInit.headers['If-None-Match']).toBeUndefined();

    expect(result).toEqual({
      markdown: 'recovered-markdown',
      source: 'atlas-fresh',
      etag: 'recoveredetag',
    });
  });

  it('(i) treats future fetchedAt as stale and fetches', async () => {
    const skewed: CacheEntry = {
      etag: 'futureetag',
      markdown: 'future-markdown',
      fetchedAt: Date.now() + 10_000,
    };
    const { fetchPlaybook } = await loadFetcher();
    const app = makeMockApp(cacheJson(skewed));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('corrected-markdown', {
        status: 200,
        headers: { etag: '"correctedetag"' },
      }),
    );

    const result = await fetchPlaybook(INBOX_ID, appAs(app), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Cache *did* parse successfully, so the conditional header is sent.
    const calledInit = fetchImpl.mock.calls[0]![1] as {
      headers: Record<string, string>;
    };
    expect(calledInit.headers['If-None-Match']).toBe('"futureetag"');

    expect(result).toEqual({
      markdown: 'corrected-markdown',
      source: 'atlas-fresh',
      etag: 'correctedetag',
    });
  });
});
