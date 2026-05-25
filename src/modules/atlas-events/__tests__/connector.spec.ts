import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ConnectorEvent } from '@atlas/connectors';

const ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HMAC = 'a'.repeat(48);
const ATLAS_URL = 'https://atlas-company-os.vercel.app';

function buildAppStub(): {
  app: FastifyInstance;
  add: ReturnType<typeof vi.fn>;
  getQueue: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn().mockResolvedValue(undefined);
  const getQueue = vi.fn().mockReturnValue({ add });
  const app = { queues: { getQueue } } as unknown as FastifyInstance;
  return { app, add, getQueue };
}

// Re-import connector + config per test so the module-level singleton AND the
// config snapshot (parsed at module load) reflect the current stubbed env.
// Mirrors enqueue.spec.ts's loadFreshModules pattern. When `enabled`, all four
// fields the boot precheck demands must be stubbed or importing config throws.
async function loadGetConnector(enabled: boolean) {
  vi.resetModules();
  if (enabled) {
    vi.stubEnv('ATLAS_CONNECTOR_ENABLED', 'true');
    vi.stubEnv('ATLAS_URL', ATLAS_URL);
    vi.stubEnv('ATLAS_ORG_ID', ORG_ID);
    vi.stubEnv('ATLAS_HMAC_SECRET', HMAC);
    vi.stubEnv('ATLAS_SOURCE_ACCOUNT_ID', ACCOUNT_ID);
  } else {
    vi.stubEnv('ATLAS_CONNECTOR_ENABLED', 'false');
  }
  const mod = await import('../connector');
  return mod.getAtlasConnector;
}

function makeEvent(): ConnectorEvent {
  const now = new Date().toISOString();
  return {
    event_id: 'msg_test-1',
    schema_version: '1.0',
    emitted_at: now,
    app: 'messaging',
    org_id: ORG_ID,
    kind: 'conversation_turn',
    action: 'create',
    source_ref: { id: 'msg-test-1' },
    occurred_at: now,
    actors: [],
    participants: [],
    summary: 'hello',
    viewable_by: { scope: 'org' },
    metadata: {},
  };
}

describe('getAtlasConnector', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when ATLAS_CONNECTOR_ENABLED=false', async () => {
    const getAtlasConnector = await loadGetConnector(false);
    const { app } = buildAppStub();
    expect(getAtlasConnector(app)).toBeNull();
  });

  it('constructs a messaging connector bound to the configured org', async () => {
    const getAtlasConnector = await loadGetConnector(true);
    const { app } = buildAppStub();
    const c = getAtlasConnector(app);
    expect(c).not.toBeNull();
    expect(c!.app).toBe('messaging');
    expect(c!.orgId).toBe(ORG_ID);
  });

  it('caches a single instance across calls (singleton)', async () => {
    const getAtlasConnector = await loadGetConnector(true);
    const { app } = buildAppStub();
    expect(getAtlasConnector(app)).toBe(getAtlasConnector(app));
  });

  it('queueAdapter.emit enqueues to atlas-events with jobId=event_id', async () => {
    const getAtlasConnector = await loadGetConnector(true);
    const { app, add, getQueue } = buildAppStub();
    const c = getAtlasConnector(app)!;
    const event = makeEvent();

    await c.emit(event);

    expect(getQueue).toHaveBeenCalledWith('atlas-events');
    expect(add).toHaveBeenCalledWith('atlas-events', event, { jobId: 'msg_test-1' });
  });
});
