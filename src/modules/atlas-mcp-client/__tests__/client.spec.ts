import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `src/config.ts` parses process.env at module-load time, and client.ts reads
// `config.ATLAS_URL` / `config.ATLAS_MCP_BEARER` at call time. Reset modules +
// restub env per test so each case sees a freshly parsed config. Mirrors
// loadFreshWorker in atlas-events/__tests__/worker.spec.ts.
const VALID_URL = 'https://atlas-company-os.vercel.app';
const VALID_BEARER = 'b'.repeat(43); // min(20) — 43-base64url-chars in prod

async function loadFreshClient(url: string | undefined, bearer: string | undefined) {
  vi.resetModules();
  if (url === undefined) {
    delete process.env.ATLAS_URL;
  } else {
    vi.stubEnv('ATLAS_URL', url);
  }
  if (bearer === undefined) {
    delete process.env.ATLAS_MCP_BEARER;
  } else {
    vi.stubEnv('ATLAS_MCP_BEARER', bearer);
  }
  return import('../client');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('atlas-mcp-client', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('isAtlasMcpConfigured reflects ATLAS_URL + ATLAS_MCP_BEARER presence', async () => {
    const both = await loadFreshClient(VALID_URL, VALID_BEARER);
    expect(both.isAtlasMcpConfigured()).toBe(true);

    const neither = await loadFreshClient(undefined, undefined);
    expect(neither.isAtlasMcpConfigured()).toBe(false);

    const onlyUrl = await loadFreshClient(VALID_URL, undefined);
    expect(onlyUrl.isAtlasMcpConfigured()).toBe(false);
  });

  it('atlasSearchMemory POSTs a tools/call JSON-RPC body with bearer + apps and returns tier groups', async () => {
    const { atlasSearchMemory } = await loadFreshClient(VALID_URL, VALID_BEARER);
    const result = { durable: [{ id: 'd1' }], episodic: [{ id: 'e1' }], sessions: [] };
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result }),
    ) as unknown as typeof fetch;

    const out = await atlasSearchMemory('renovação Folego', ['messaging'], { fetchImpl });

    expect(out).toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${VALID_URL}/api/connectors/atlas-mcp`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${VALID_BEARER}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('tools/call');
    expect(sent.params.name).toBe('atlas.search_memory');
    expect(sent.params.arguments).toEqual({ query: 'renovação Folego', apps: ['messaging'] });
  });

  it('atlasSearchMemory omits apps when not provided', async () => {
    const { atlasSearchMemory } = await loadFreshClient(VALID_URL, VALID_BEARER);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { durable: [], episodic: [], sessions: [] } }),
    ) as unknown as typeof fetch;

    await atlasSearchMemory('just a query', undefined, { fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sent = JSON.parse(init.body as string);
    expect(sent.params.arguments).toEqual({ query: 'just a query' });
  });

  it('atlasRecentActivity defaults app to messaging and returns rows', async () => {
    const { atlasRecentActivity } = await loadFreshClient(VALID_URL, VALID_BEARER);
    const rows = [{ eventId: 'msg_1', kind: 'conversation_turn', sourceApp: 'messaging', sourceRefId: '1', occurredAt: '2026-05-25T00:00:00.000Z', summary: 's' }];
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { rows } }),
    ) as unknown as typeof fetch;

    const out = await atlasRecentActivity(undefined, { fetchImpl });

    expect(out.rows).toEqual(rows);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sent = JSON.parse(init.body as string);
    expect(sent.params.name).toBe('atlas.recent_activity');
    expect(sent.params.arguments).toEqual({ app: 'messaging' });
  });

  it('throws AtlasMcpError when ATLAS_MCP_BEARER is unset (gated, §C.6)', async () => {
    const { atlasSearchMemory, AtlasMcpError } = await loadFreshClient(VALID_URL, undefined);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(atlasSearchMemory('q', undefined, { fetchImpl })).rejects.toBeInstanceOf(
      AtlasMcpError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a JSON-RPC error body (method/tool errors return HTTP 200)', async () => {
    const { atlasSearchMemory, AtlasMcpError } = await loadFreshClient(VALID_URL, VALID_BEARER);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found: bogus' } }),
    ) as unknown as typeof fetch;

    const err = await atlasSearchMemory('q', undefined, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasMcpError);
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('method not found');
  });

  it('surfaces a 401 auth failure (JSON-RPC error body carried on a non-2xx)', async () => {
    const { atlasRecentActivity, AtlasMcpError } = await loadFreshClient(VALID_URL, VALID_BEARER);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'auth: invalid-bearer' } }, 401),
    ) as unknown as typeof fetch;

    const err = await atlasRecentActivity(undefined, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasMcpError);
    expect(err.message).toContain('auth: invalid-bearer');
  });

  it('throws on network failure', async () => {
    const { atlasSearchMemory, AtlasMcpError } = await loadFreshClient(VALID_URL, VALID_BEARER);
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const err = await atlasSearchMemory('q', undefined, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasMcpError);
    expect(err.message).toContain('network/timeout');
  });
});
