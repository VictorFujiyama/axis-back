import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signRequest, type ConnectorEvent } from '@atlas/connectors';

// T-012/T-06: POST /atlas-events inbound push route. Trust-boundary cases:
// valid push → 200 + row, invalid HMAC → 401, malformed envelope → 400, org-id
// header ≠ envelope.org_id → 400 (#8, subscriber.ts cross-check), and (T-06)
// an org with no connection → 401.
//
// Uses the L-418 dynamic-import pattern (mcp-server.spec.ts precedent): each
// case parses a fresh `config` singleton from the stubbed environment, since
// config.ts reads `process.env` at module load and the plugin reads
// `config.ATLAS_CONNECTOR_ENABLED` at registration time.
//
// Per-account (T-06): the route now resolves the HMAC secret per org from
// `atlas_connections`. We mock `getConnectionByOrg` (the same module-mock
// pattern enqueue.spec uses) so the REAL `AtlasSubscriber` verifies against the
// connection's secret without touching DB or crypto. Default impl returns a
// connection for ATLAS_ORG_ID and null for any other org.
//
// `signRequest` is a pure value function (HMAC over bytes); importing it once
// at the top is safe even though the route imports its own SDK copy — there is
// no cross-module identity check here (contrast L-617's instanceof trap).

const TEST_SECRET = 'test-atlas-hmac-secret-' + 'a'.repeat(32);
const ATLAS_ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const OTHER_ORG_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = '33333333-4444-5555-6666-777777777777';

// Per-account connection store (T-06). Mock so the route resolves a per-org
// HMAC secret without DB/crypto; the real AtlasSubscriber does the verify.
const connectionsMock = vi.hoisted(() => ({ getConnectionByOrg: vi.fn() }));
vi.mock('../../atlas-events/connections', () => connectionsMock);

/** A decrypted `atlas_connections` view (what `getConnectionByOrg` returns).
 * The route reads `secrets.hmacSecret` to verify and `atlasOrgId` for context. */
function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atlas-conn-1',
    atlasAccountId: ACCOUNT_ID,
    atlasOrgId: ATLAS_ORG_ID,
    status: 'active' as const,
    secrets: { hmacSecret: TEST_SECRET, mcpBearer: 'mcp-bearer-xyz' },
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

function validEvent(orgId: string = ATLAS_ORG_ID): ConnectorEvent {
  return {
    event_id: 'mem_abc123',
    schema_version: '1.0',
    emitted_at: '2026-05-25T12:00:00.000Z',
    app: 'atlas',
    org_id: orgId,
    kind: 'memory_write',
    action: 'create',
    source_ref: { id: 'mem-1' },
    occurred_at: '2026-05-25T12:00:00.000Z',
    actors: [],
    participants: [],
    summary: 'Atlas remembered something about João',
    viewable_by: { scope: 'org' },
    metadata: {},
  };
}

interface InsertCapture {
  rows: Array<Record<string, unknown>>;
  onConflict: ReturnType<typeof vi.fn>;
}

function makeDb(): { db: FastifyInstance['db']; capture: InsertCapture } {
  const capture: InsertCapture = { rows: [], onConflict: vi.fn().mockResolvedValue(undefined) };
  const values = vi.fn((row: Record<string, unknown>) => {
    capture.rows.push(row);
    return { onConflictDoNothing: capture.onConflict };
  });
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as unknown as FastifyInstance['db'], capture };
}

async function buildTestApp(): Promise<{ app: FastifyInstance; capture: InsertCapture }> {
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const { atlasInboundRoutes } = await import('../inbound-routes.js');

  const app = Fastify({ logger: false });
  const { db, capture } = makeDb();
  app.decorate('db', db);
  await app.register(atlasInboundRoutes);
  await app.ready();
  return { app, capture };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // Boot precheck (T-003) requires all four when the connector is enabled
  // (the route no longer reads them — T-10 removes them from config).
  vi.stubEnv('ATLAS_CONNECTOR_ENABLED', 'true');
  vi.stubEnv('ATLAS_URL', 'https://atlas-company-os.vercel.app');
  vi.stubEnv('ATLAS_ORG_ID', ATLAS_ORG_ID);
  vi.stubEnv('ATLAS_HMAC_SECRET', TEST_SECRET);
  vi.stubEnv('ATLAS_SOURCE_ACCOUNT_ID', ATLAS_ORG_ID);
  // Per-org connection lookup: connected for ATLAS_ORG_ID, unknown otherwise.
  connectionsMock.getConnectionByOrg.mockReset();
  connectionsMock.getConnectionByOrg.mockImplementation(async (_db: unknown, org: string) =>
    org === ATLAS_ORG_ID ? fakeConnection() : null,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('atlas inbound route — disabled by default (T-012)', () => {
  it('returns 404 when ATLAS_CONNECTOR_ENABLED=false', async () => {
    vi.stubEnv('ATLAS_CONNECTOR_ENABLED', 'false');
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/atlas-events',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(validEvent()),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('atlas inbound route — POST /atlas-events (T-012)', () => {
  it('valid signed push → 200 and persists one atlas_activity row', async () => {
    const { app, capture } = await buildTestApp();
    try {
      const rawBody = JSON.stringify(validEvent());
      const { signature, orgIdHeader } = signRequest(rawBody, ATLAS_ORG_ID, TEST_SECRET);

      const res = await app.inject({
        method: 'POST',
        url: '/atlas-events',
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': signature,
          'x-atlas-org-id': orgIdHeader,
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, event_id: 'mem_abc123' });
      expect(capture.rows).toHaveLength(1);
      expect(capture.rows[0]).toMatchObject({
        eventId: 'mem_abc123',
        kind: 'memory_write',
        orgId: ATLAS_ORG_ID,
        summary: 'Atlas remembered something about João',
      });
      expect(capture.onConflict).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('org with no connection → 401 and no row written (T-06)', async () => {
    const { app, capture } = await buildTestApp();
    try {
      // OTHER_ORG_ID has no connection → getConnectionByOrg returns null → 401
      // before any HMAC work. Sign with a valid secret to prove the rejection
      // is the missing connection, not a bad signature.
      const rawBody = JSON.stringify(validEvent(OTHER_ORG_ID));
      const { signature, orgIdHeader } = signRequest(rawBody, OTHER_ORG_ID, TEST_SECRET);
      const res = await app.inject({
        method: 'POST',
        url: '/atlas-events',
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': signature,
          'x-atlas-org-id': orgIdHeader,
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ ok: false });
      expect(capture.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('invalid HMAC → 401 and no row written', async () => {
    const { app, capture } = await buildTestApp();
    try {
      const rawBody = JSON.stringify(validEvent());
      const res = await app.inject({
        method: 'POST',
        url: '/atlas-events',
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': 't=1700000000,v1=deadbeef',
          'x-atlas-org-id': ATLAS_ORG_ID,
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ ok: false });
      expect(capture.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('malformed envelope (valid HMAC, bad schema) → 400', async () => {
    const { app, capture } = await buildTestApp();
    try {
      // Valid JSON but missing required envelope fields — sign it so HMAC
      // passes and the failure is purely the Zod parse.
      const rawBody = JSON.stringify({ event_id: 'mem_x', org_id: ATLAS_ORG_ID });
      const { signature, orgIdHeader } = signRequest(rawBody, ATLAS_ORG_ID, TEST_SECRET);

      const res = await app.inject({
        method: 'POST',
        url: '/atlas-events',
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': signature,
          'x-atlas-org-id': orgIdHeader,
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false });
      expect(res.json().error).toContain('envelope');
      expect(capture.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('org-id header ≠ envelope.org_id → 400 (#8 cross-check)', async () => {
    const { app, capture } = await buildTestApp();
    try {
      // Envelope carries OTHER_ORG_ID, but we sign + send the header as
      // ATLAS_ORG_ID. HMAC verifies (signed with the header's org), then the
      // subscriber's body-vs-header cross-check fails → 400.
      const rawBody = JSON.stringify(validEvent(OTHER_ORG_ID));
      const { signature, orgIdHeader } = signRequest(rawBody, ATLAS_ORG_ID, TEST_SECRET);

      const res = await app.inject({
        method: 'POST',
        url: '/atlas-events',
        headers: {
          'content-type': 'application/json',
          'x-atlas-signature': signature,
          'x-atlas-org-id': orgIdHeader,
        },
        payload: rawBody,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('org_id');
      expect(capture.rows).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
