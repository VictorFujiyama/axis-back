import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@blossom/db';
import { parseConnectorEvent } from '@atlas/connectors';

import { buildMessageFailedEnvelope } from '../build-connector-event';
import { MESSAGE_FAILED_KIND } from '../message-failed';

// Mock the per-account connection store so the REAL `getConnectorForAccount`
// builds a real connector (whose queueAdapter calls `queue.add`) without
// touching the DB or crypto — same approach as enqueue.spec.ts. `getConnection`
// returns a connection by default; the anti-leak case overrides it to null.
const connectionsMock = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../connections', () => connectionsMock);

const ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const HMAC_SECRET = 'b'.repeat(48);
const CONNECTOR_URL = 'https://atlas-company-os.vercel.app';

function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atlas-conn-1',
    atlasAccountId: ACCOUNT_ID,
    atlasOrgId: ORG_ID,
    status: 'active' as const,
    secrets: { hmacSecret: HMAC_SECRET, mcpBearer: 'mcp-bearer-xyz' },
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Mock the `app.db.select().from().where().limit()` chain: each `.limit()`
 * resolves to the next row-set. `emitMessageFailed` issues 1) inbox → accountId,
 * 2) message → metadata. */
function makeDb(rowSets: Array<unknown[]>): DB {
  const limit = vi.fn();
  for (const rs of rowSets) limit.mockResolvedValueOnce(rs);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as DB;
}

function buildAppStub(rowSets: Array<unknown[]>, addImpl?: ReturnType<typeof vi.fn>) {
  const add = addImpl ?? vi.fn().mockResolvedValue(undefined);
  const getQueue = vi.fn().mockReturnValue({ add });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const app = {
    db: makeDb(rowSets),
    queues: { getQueue },
    log,
  } as unknown as FastifyInstance;
  return { app, add, getQueue, log };
}

/** Re-import enqueue with `ATLAS_URL` stubbed so config.ts (parsed at module
 * load) sees the connector master switch as on. resetModules also clears the
 * per-account connector cache in connector.ts. */
async function loadEmit(opts: { atlasUrl?: string } = {}) {
  vi.resetModules();
  if (opts.atlasUrl) vi.stubEnv('ATLAS_URL', opts.atlasUrl);
  const mod = await import('../enqueue');
  return mod.emitMessageFailed;
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('buildMessageFailedEnvelope', () => {
  // Test 1: a fully-populated input yields a schema-valid envelope carrying
  // every payload field under metadata.message_failed.
  it('builds a valid ConnectorEvent with all fields', () => {
    const ev = buildMessageFailedEnvelope({
      orgId: ORG_ID,
      accountId: ACCOUNT_ID,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      channel: 'email',
      failureReason: 'gmail: 550 mailbox unavailable',
      failedAt: new Date('2026-06-10T12:00:00Z'),
      sentByJourneyRunId: 'run-9',
    });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.kind).toBe(MESSAGE_FAILED_KIND);
    expect(ev.action).toBe('update');
    expect(ev.event_id).toBe('msg_msg-1:failed');
    expect(ev.org_id).toBe(ORG_ID);
    expect(ev.source_ref).toEqual({ id: 'msg-1', parent_id: 'conv-1' });
    expect(ev.metadata['accountId']).toBe(ACCOUNT_ID);
    expect(ev.metadata['message_failed']).toEqual({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      channel: 'email',
      failureReason: 'gmail: 550 mailbox unavailable',
      failedAt: '2026-06-10T12:00:00.000Z',
      sentByJourneyRunId: 'run-9',
    });
  });

  // Test 2: a non-journey send omits sentByJourneyRunId entirely (not null) so
  // the Atlas handler skips the D13 journey_run_events update.
  it('omits sentByJourneyRunId when absent', () => {
    const ev = buildMessageFailedEnvelope({
      orgId: ORG_ID,
      conversationId: 'conv-2',
      messageId: 'msg-2',
      channel: 'whatsapp',
      failureReason: 'whatsapp: 131026 message undeliverable',
      failedAt: '2026-06-10T13:00:00.000Z',
    });

    const payload = ev.metadata['message_failed'] as Record<string, unknown>;
    expect('sentByJourneyRunId' in payload).toBe(false);
    expect(payload['channel']).toBe('whatsapp');
    expect(parseConnectorEvent(ev).ok).toBe(true);
  });

  // Test 6: occurred_at mirrors the failure time, NOT the (later) build time, so
  // Atlas telemetry timestamps the real failure.
  it('sets occurred_at to failedAt, not the build time', () => {
    const failedAt = new Date('2026-06-10T12:00:00Z');
    const ev = buildMessageFailedEnvelope({
      orgId: ORG_ID,
      conversationId: 'conv-3',
      messageId: 'msg-3',
      channel: 'telegram',
      failureReason: 'telegram: 403 bot blocked by user',
      failedAt,
    });

    expect(ev.occurred_at).toBe('2026-06-10T12:00:00.000Z');
    // emitted_at is the build time (now) — distinct from occurred_at.
    expect(ev.emitted_at).not.toBe(ev.occurred_at);
  });
});

describe('emitMessageFailed', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    connectionsMock.getConnection.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const failParams = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    inboxId: 'inbox-1',
    channel: 'email',
    failureReason: 'gmail: 550 mailbox unavailable',
    failedAt: new Date('2026-06-10T12:00:00Z'),
  };

  // Test 3: with the connector on and a live connection, the failure rides the
  // per-account connector pipeline → queue.add with jobId = event_id.
  it('emits a message.failed envelope when the account has a connection', async () => {
    connectionsMock.getConnection.mockResolvedValue(fakeConnection());
    const emitMessageFailed = await loadEmit({ atlasUrl: CONNECTOR_URL });
    const { app, add } = buildAppStub([
      [{ accountId: ACCOUNT_ID }], // inbox → accountId
      [{ metadata: {} }], // message → no journey origin
    ]);

    await emitMessageFailed(app, failParams);
    await flushMicrotasks();

    expect(add).toHaveBeenCalledTimes(1);
    const [, envelope] = add.mock.calls[0]!;
    expect((envelope as { kind: string }).kind).toBe(MESSAGE_FAILED_KIND);
    expect((envelope as { event_id: string }).event_id).toBe('msg_msg-1:failed');
  });

  // Test 4: anti-leak — an account with no Atlas connection never emits (the
  // worker still marked the message failed locally; nothing goes on the wire).
  it('does not emit when the account has no connection', async () => {
    connectionsMock.getConnection.mockResolvedValue(null);
    const emitMessageFailed = await loadEmit({ atlasUrl: CONNECTOR_URL });
    const { app, add } = buildAppStub([[{ accountId: ACCOUNT_ID }]]);

    await emitMessageFailed(app, failParams);
    await flushMicrotasks();

    expect(add).not.toHaveBeenCalled();
  });

  // Test 5: fail-open — an emit error must never bubble back into the worker's
  // failed handler; it is swallowed with a warn log.
  it('logs a warning and does not throw when emit fails', async () => {
    connectionsMock.getConnection.mockResolvedValue(fakeConnection());
    const emitMessageFailed = await loadEmit({ atlasUrl: CONNECTOR_URL });
    const throwingAdd = vi.fn().mockRejectedValue(new Error('redis down'));
    const { app, add, log } = buildAppStub(
      [[{ accountId: ACCOUNT_ID }], [{ metadata: {} }]],
      throwingAdd,
    );

    await expect(emitMessageFailed(app, failParams)).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(add).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
