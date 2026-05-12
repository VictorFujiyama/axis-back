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
    // Default config: MCP_SERVER_ENABLED unset → false. No secret needed.
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
