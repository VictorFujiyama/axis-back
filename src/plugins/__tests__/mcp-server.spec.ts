import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-015a: MCP server plugin skeleton spike. Two cases enforce the trust
// boundaries before T-015b wires real tools:
//
//   - MCP_SERVER_ENABLED=false  → /mcp falls through to 404 (plugin no-ops).
//   - MCP_SERVER_ENABLED=true + invalid HMAC → 401.
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
