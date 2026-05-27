import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ConnectorEvent } from '@atlas/connectors';
import { encryptJSON } from '../../../crypto';

const ORG_ID = 'f4c373d8-fb00-4423-91f1-e1380669a7d2';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HMAC = 'h'.repeat(48);
const HMAC_ROTATED = 'r'.repeat(48);
const ATLAS_URL = 'https://atlas-company-os.vercel.app';

/** A stored `atlas_connections` row as it comes back from the DB (secrets encrypted). */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    atlasAccountId: ACCOUNT_ID,
    atlasOrgId: ORG_ID,
    secretsEnc: encryptJSON({ hmacSecret: HMAC, mcpBearer: 'bearer-x' }),
    status: 'active' as const,
    createdAt: new Date('2026-05-27T00:00:00Z'),
    updatedAt: new Date('2026-05-27T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Stub the FastifyInstance: `app.db` drives the real `getConnection`
 * (`select().from().where().limit()` → rows), `app.queues` spies on the queue
 * the connector's `queueAdapter` enqueues to. `rowsPerCall` lets a test return a
 * different row on the second `getConnection` (secret rotation).
 */
function buildAppStub(...rowsPerCall: unknown[][]) {
  const limit = vi.fn();
  for (const rows of rowsPerCall) limit.mockResolvedValueOnce(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const add = vi.fn().mockResolvedValue(undefined);
  const getQueue = vi.fn().mockReturnValue({ add });
  const app = { db: { select }, queues: { getQueue } } as unknown as FastifyInstance;
  return { app, add, getQueue };
}

// Re-import per test so the module-level cache AND the config snapshot reflect
// the stubbed env (mirrors connector.spec.ts's loadFreshModules pattern).
async function loadConnectorMod(withAtlasUrl = true) {
  vi.resetModules();
  if (withAtlasUrl) vi.stubEnv('ATLAS_URL', ATLAS_URL);
  return import('../connector');
}

function makeEvent(): ConnectorEvent {
  const now = new Date().toISOString();
  return {
    event_id: 'msg_per-account-1',
    schema_version: '1.0',
    emitted_at: now,
    app: 'messaging',
    org_id: ORG_ID,
    kind: 'conversation_turn',
    action: 'create',
    source_ref: { id: 'msg-1' },
    occurred_at: now,
    actors: [],
    participants: [],
    summary: 'hello',
    viewable_by: { scope: 'org' },
    metadata: {},
  };
}

describe('getConnectorForAccount', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when the account has no connection (anti-leak)', async () => {
    const { getConnectorForAccount } = await loadConnectorMod();
    const { app } = buildAppStub([]);
    expect(await getConnectorForAccount(app, ACCOUNT_ID)).toBeNull();
  });

  it("builds a messaging connector bound to the connection's org + secret", async () => {
    const { getConnectorForAccount } = await loadConnectorMod();
    const { app } = buildAppStub([makeRow()]);
    const c = await getConnectorForAccount(app, ACCOUNT_ID);
    expect(c).not.toBeNull();
    expect(c!.app).toBe('messaging');
    expect(c!.orgId).toBe(ORG_ID);
  });

  it('caches one instance per account while org + secret are unchanged', async () => {
    const { getConnectorForAccount } = await loadConnectorMod();
    const { app } = buildAppStub([makeRow()], [makeRow()]);
    const first = await getConnectorForAccount(app, ACCOUNT_ID);
    const second = await getConnectorForAccount(app, ACCOUNT_ID);
    expect(first).toBe(second);
  });

  it('rebuilds when the stored secret rotates (no stale HMAC)', async () => {
    const { getConnectorForAccount } = await loadConnectorMod();
    const rotated = makeRow({
      secretsEnc: encryptJSON({ hmacSecret: HMAC_ROTATED, mcpBearer: 'bearer-x' }),
    });
    const { app } = buildAppStub([makeRow()], [rotated]);
    const first = await getConnectorForAccount(app, ACCOUNT_ID);
    const second = await getConnectorForAccount(app, ACCOUNT_ID);
    expect(first).not.toBe(second);
  });

  it('clearConnectorCache forces a rebuild on the next call', async () => {
    const { getConnectorForAccount, clearConnectorCache } = await loadConnectorMod();
    const { app } = buildAppStub([makeRow()], [makeRow()]);
    const first = await getConnectorForAccount(app, ACCOUNT_ID);
    clearConnectorCache(ACCOUNT_ID);
    const second = await getConnectorForAccount(app, ACCOUNT_ID);
    expect(first).not.toBe(second);
  });

  it('queueAdapter.emit enqueues to atlas-events with jobId=event_id', async () => {
    const { getConnectorForAccount } = await loadConnectorMod();
    const { app, add, getQueue } = buildAppStub([makeRow()]);
    const c = (await getConnectorForAccount(app, ACCOUNT_ID))!;

    await c.emit(makeEvent());

    expect(getQueue).toHaveBeenCalledWith('atlas-events');
    expect(add).toHaveBeenCalledWith('atlas-events', expect.objectContaining({ event_id: 'msg_per-account-1' }), {
      jobId: 'msg_per-account-1',
    });
  });

  it('throws when ATLAS_URL is unset but a connection exists', async () => {
    const { getConnectorForAccount } = await loadConnectorMod(false);
    const { app } = buildAppStub([makeRow()]);
    await expect(getConnectorForAccount(app, ACCOUNT_ID)).rejects.toThrow(/ATLAS_URL unset/);
  });
});
