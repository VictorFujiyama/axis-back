import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signOutboundPayload } from '../../modules/webhooks/sign';

// T-015a: MCP server plugin skeleton spike. Two cases enforce the trust
// boundaries before T-015b wires real tools:
//
//   - MCP_SERVER_ENABLED=false  → /mcp falls through to 404 (plugin no-ops).
//   - MCP_SERVER_ENABLED=true + invalid HMAC → 401.
//
// T-016 added the valid-HMAC happy-path case: a Stripe-style signed
// `initialize` JSON-RPC request reaches the streaming transport and returns
// 200, proving the HMAC preHandler + plugin-scoped JSON body parser + hijacked
// streaming plumbing all line up. The exhaustive `listTools()` → 3 tools
// assertion lives in `modules/atlas-mcp/__tests__/server.spec.ts` (T-015b)
// over `InMemoryTransport`, per the L-419 unit-style preference.
//
// Uses the L-418 dynamic-import pattern so each case parses a fresh `config`
// singleton from the stubbed environment (the config module parses
// `process.env` at module load time).

const TEST_SECRET = 'test-mcp-hmac-secret-' + 'a'.repeat(32);
const TEST_BEARER_KEY = 'test-mcp-bearer-key-' + 'b'.repeat(32);

async function buildTestApp(): Promise<FastifyInstance> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const { mcpServerPlugin } = await import('../mcp-server.js');

  const app = Fastify({ logger: false });
  // `buildMcpServer(app.db)` runs per request; for the initialize handshake
  // no tool handler fires so a null stub is enough. Tool-level db access is
  // covered by `tools.spec.ts` / `server.spec.ts`.
  app.decorate('db', null as unknown as FastifyInstance['db']);
  await app.register(mcpServerPlugin);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mcp-server plugin — disabled by default (T-015a)', () => {
  it('returns 404 when MCP_SERVER_ENABLED=false', async () => {
    // Stub explicit pra evitar dependência de .env local que pode ter MCP_SERVER_ENABLED=true (smoke setup).
    vi.stubEnv('MCP_SERVER_ENABLED', 'false');
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('mcp-server plugin — invalid HMAC (T-015a)', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', TEST_SECRET);
    // T-003: default MCP_AUTH_MODE='both' requires MCP_AXIS_API_KEY at boot.
    // These cases still exercise the HMAC fallback (no Authorization header
    // in the request → Bearer check returns null → falls through to HMAC).
    vi.stubEnv('MCP_AXIS_API_KEY', TEST_BEARER_KEY);
  });

  it('returns 401 when X-Atlas-Signature is missing', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining('missing'),
      });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when X-Atlas-Signature has a bogus value', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': 't=1700000000,v1=deadbeef',
        },
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining('invalid'),
      });
    } finally {
      await app.close();
    }
  });
});

describe('mcp-server plugin — valid HMAC handshake (T-016)', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', TEST_SECRET);
    vi.stubEnv('MCP_AXIS_API_KEY', TEST_BEARER_KEY);
  });

  it('lets a valid HMAC-signed initialize request through the transport (200)', async () => {
    const app = await buildTestApp();
    try {
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mcp-server-spec', version: '0.0.0' },
        },
      });
      const sig = signOutboundPayload(initBody, TEST_SECRET);

      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-atlas-signature': sig,
        },
        payload: initBody,
      });

      // 200 proves three things at once: (a) MCP_SERVER_ENABLED gate opened
      // the route, (b) the plugin-scoped JSON parser captured raw bytes and
      // re-parsed `request.body`, and (c) the HMAC preHandler accepted the
      // Stripe-style signature. The transport then handled the initialize
      // handshake end-to-end. Any failure on (a)/(b)/(c) would surface as 401
      // or 404 — see the other describes in this file.
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('mcp-server plugin — Bearer auth (T-005)', () => {
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    id: 1,
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-server-spec', version: '0.0.0' },
    },
  });

  describe('mode=both (default) — Bearer primary, HMAC fallback available', () => {
    beforeEach(() => {
      vi.stubEnv('MCP_SERVER_ENABLED', 'true');
      vi.stubEnv('ATLAS_MCP_HMAC_SECRET', TEST_SECRET);
      vi.stubEnv('MCP_AXIS_API_KEY', TEST_BEARER_KEY);
      // MCP_AUTH_MODE defaults to 'both' per T-003.
    });

    it('lets a valid Bearer-authenticated initialize request through the transport (200)', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${TEST_BEARER_KEY}`,
          },
          payload: initBody,
        });
        // 200 proves the Bearer code path: preHandler took the Bearer branch
        // (Authorization present), constant-time-matched the key, and let the
        // transport handle the handshake. No X-Atlas-Signature header on this
        // request — HMAC was never consulted.
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('mode=bearer pure — no HMAC secret required', () => {
    beforeEach(() => {
      vi.stubEnv('MCP_SERVER_ENABLED', 'true');
      vi.stubEnv('MCP_AUTH_MODE', 'bearer');
      vi.stubEnv('MCP_AXIS_API_KEY', TEST_BEARER_KEY);
      // ATLAS_MCP_HMAC_SECRET deliberately unset — T-003 precheck allows this
      // for mode='bearer' (HMAC explicitly not used).
    });

    it('boots the plugin without ATLAS_MCP_HMAC_SECRET and accepts a valid Bearer (200)', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${TEST_BEARER_KEY}`,
          },
          payload: initBody,
        });
        // 200 here is the activation-story guarantee: with the HMAC secret
        // unset, the old gate at the top of `mcpServerPlugin` would have
        // early-returned and given a 404. T-005 removed that gate; boot
        // misconfig handling now lives entirely in `config.ts` T-003 precheck.
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });
});
