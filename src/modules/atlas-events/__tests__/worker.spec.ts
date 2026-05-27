import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { ConnectorEmitFailedError, type ConnectorEvent } from '@atlas/connectors';

import type { AtlasEventJob } from '../enqueue';

// Mock the per-account connector resolver: worker tests verify the worker's
// DISPATCH + error contract (4xx terminal vs 5xx rethrow vs no-connection), NOT
// the SDK's retry internals (covered by the SDK's own suite). The mock drives
// emitDirect's outcome without real backoff sleeps or a live Atlas endpoint.
// Post-T-05 the worker resolves the connector by the job's `metadata.accountId`
// via `getConnectorForAccount` (async). Legacy/§12.1 jobs never hit it
// (isConnectorEvent === false), so those cases are untouched. Mirrors
// enqueue.spec's vi.hoisted+vi.mock pattern.
const connectorMock = vi.hoisted(() => ({
  getConnectorForAccount: vi.fn(),
}));
vi.mock('../connector', () => connectorMock);

interface AppStub {
  app: FastifyInstance;
  queues: {
    registerWorker: ReturnType<typeof vi.fn>;
  };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function buildAppStub(): AppStub {
  const registerWorker = vi.fn();
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  const app = {
    queues: { registerWorker },
    log,
  } as unknown as FastifyInstance;
  return { app, queues: { registerWorker }, log };
}

// `src/config.ts` parses process.env at module-load time, and worker.ts reads
// `config.ATLAS_BASE_URL`/`config.ATLAS_EVENTS_HMAC_SECRET`/
// `config.ATLAS_EVENTS_ENDPOINT` at handler invocation. Reset modules + restub
// env per test so each case sees a freshly parsed config. Mirrors
// loadFreshModules in enqueue.spec.ts.
async function loadFreshWorker(
  secret: string | undefined,
  baseUrl: string | undefined,
  endpoint?: string,
  connectorEnabled = false,
) {
  vi.resetModules();
  if (secret === undefined) {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', '');
    delete process.env.ATLAS_EVENTS_HMAC_SECRET;
  } else {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', secret);
  }
  if (baseUrl === undefined) {
    vi.stubEnv('ATLAS_BASE_URL', '');
    delete process.env.ATLAS_BASE_URL;
  } else {
    vi.stubEnv('ATLAS_BASE_URL', baseUrl);
  }
  if (endpoint !== undefined) {
    vi.stubEnv('ATLAS_EVENTS_ENDPOINT', endpoint);
  } else {
    delete process.env.ATLAS_EVENTS_ENDPOINT;
  }
  if (connectorEnabled) {
    // ATLAS_URL alone is the connector master switch now (Connect Flow T-10).
    vi.stubEnv('ATLAS_URL', CONNECTOR_URL);
  }
  const mod = await import('../worker');
  return { registerAtlasEventsWorker: mod.registerAtlasEventsWorker };
}

const VALID_SECRET = 'a'.repeat(64);
const VALID_BASE_URL = 'http://atlas-web:3010';

// Phase 12.2 connector env fixtures (must be schema-valid: uuid / url / min-len).
const CONNECTOR_ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const CONNECTOR_URL = 'https://atlas-company-os.vercel.app';
const SOURCE_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function makeConnectorJob(): { id: string; data: ConnectorEvent } {
  return {
    id: 'job-conn-1',
    data: {
      event_id: 'msg_msg-xyz',
      schema_version: '1.0',
      emitted_at: '2026-05-12T08:00:00.000Z',
      app: 'messaging',
      org_id: CONNECTOR_ORG_ID,
      kind: 'conversation_turn',
      action: 'create',
      source_ref: { id: 'msg-xyz', parent_id: 'conv-abc' },
      occurred_at: '2026-05-12T08:00:00.000Z',
      actors: [
        { app_user_id: 'contact-1', role: 'sender', hints: { email: 'a@b.com' } },
      ],
      participants: [],
      summary: 'contact: hello there',
      viewable_by: { scope: 'org' },
      metadata: { accountId: SOURCE_ACCOUNT_ID },
    },
  };
}

function makeJob(): { id: string; data: AtlasEventJob } {
  return {
    id: 'job-123',
    data: {
      type: 'message_sent',
      conversationId: 'conv-abc',
      messageId: 'msg-xyz',
      occurredAt: '2026-05-11T12:00:00.000Z',
      summary: 'contact: hello world',
    },
  };
}

type Processor = (job: {
  id: string;
  data: AtlasEventJob | ConnectorEvent;
}) => Promise<void>;

function captureHandler(registerWorker: ReturnType<typeof vi.fn>): Processor {
  expect(registerWorker).toHaveBeenCalledTimes(1);
  const [name, processor, concurrency] = registerWorker.mock.calls[0]!;
  expect(name).toBe('atlas-events');
  expect(concurrency).toBe(5);
  return processor as Processor;
}

describe('registerAtlasEventsWorker', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    connectorMock.getConnectorForAccount.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is a no-op when ATLAS_EVENTS_HMAC_SECRET is unset', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      undefined,
      VALID_BASE_URL,
    );
    const { app, queues, log } = buildAppStub();
    const fetchImpl = vi.fn();

    registerAtlasEventsWorker(app, { fetchImpl });

    expect(queues.registerWorker).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signs the body and POSTs to the default Phase B endpoint on 2xx (Phase D Activation default)', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      VALID_BASE_URL,
    );
    const { app, queues, log } = buildAppStub();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 202 }));

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    await handler(makeJob());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${VALID_BASE_URL}/api/messaging/events`);
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Atlas-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // The signature must reproduce when re-computed with the same body+secret.
    const body = (init as RequestInit).body as string;
    const match = headers['X-Atlas-Signature']!.match(
      /^t=(\d+),v1=([a-f0-9]{64})$/,
    );
    expect(match).not.toBeNull();
    const t = match![1]!;
    const v1 = match![2]!;
    const expected = createHmac('sha256', VALID_SECRET)
      .update(`${t}.${body}`)
      .digest('hex');
    expect(v1).toBe(expected);

    expect(log.info).toHaveBeenCalled();
    const lastInfo = log.info.mock.calls.at(-1)![0];
    expect(lastInfo).toMatchObject({
      jobId: 'job-123',
      jobType: 'message_sent',
      conversationId: 'conv-abc',
      status: 202,
    });
  });

  it('does not throw on 4xx — marks job complete (no retry)', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      VALID_BASE_URL,
    );
    const { app, queues, log } = buildAppStub();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('bad', { status: 400 }));

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
    const lastWarn = log.warn.mock.calls.at(-1)![0];
    expect(lastWarn).toMatchObject({ status: 400, jobId: 'job-123' });
  });

  it('throws on 5xx so BullMQ retries', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      VALID_BASE_URL,
    );
    const { app, queues } = buildAppStub();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 502 }));

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    await expect(handler(makeJob())).rejects.toThrow(/atlas-events 502/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws on AbortError so BullMQ retries', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      VALID_BASE_URL,
    );
    const { app, queues, log } = buildAppStub();
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const fetchImpl = vi.fn().mockRejectedValue(abortErr);

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    await expect(handler(makeJob())).rejects.toBe(abortErr);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it('serializes Phase 12 kind-envelope to snake_case wire shape and POSTs to default endpoint', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      VALID_BASE_URL,
    );
    const { app, queues, log } = buildAppStub();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 202 }));

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    const envelopeJob: { id: string; data: AtlasEventJob } = {
      id: 'job-env-1',
      data: {
        kind: 'conversation_turn',
        action: 'create',
        sourceRef: 'conv-abc:message_sent:msg-xyz',
        occurredAt: '2026-05-12T08:00:00.000Z',
        summary: 'contact: hello there',
        accountId: 'acct-1',
        actors: [
          { kind: 'bot', id: 'bot-1', appUserId: 'clerk_user_42' },
        ],
        participants: [
          { kind: 'contact', id: 'cont-1' },
          { kind: 'user', id: 'user-1' },
        ],
        viewableBy: { scope: 'org' },
        payload: { conversationId: 'conv-abc', messageId: 'msg-xyz' },
      },
    };

    await handler(envelopeJob);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${VALID_BASE_URL}/api/messaging/events`);

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      kind: 'conversation_turn',
      action: 'create',
      source_ref: 'conv-abc:message_sent:msg-xyz',
      occurred_at: '2026-05-12T08:00:00.000Z',
      summary: 'contact: hello there',
      account_id: 'acct-1',
      actors: [
        { kind: 'bot', id: 'bot-1', app_user_id: 'clerk_user_42' },
      ],
      participants: [
        { kind: 'contact', id: 'cont-1' },
        { kind: 'user', id: 'user-1' },
      ],
      viewable_by: { scope: 'org' },
      payload: { conversationId: 'conv-abc', messageId: 'msg-xyz' },
    });

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Atlas-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    expect(log.info).toHaveBeenCalled();
    const lastInfo = log.info.mock.calls.at(-1)![0];
    expect(lastInfo).toMatchObject({
      jobId: 'job-env-1',
      jobKind: 'conversation_turn',
      jobAction: 'create',
      sourceRef: 'conv-abc:message_sent:msg-xyz',
      accountId: 'acct-1',
      status: 202,
    });
  });

  it('honors ATLAS_EVENTS_ENDPOINT override to roll back to the Phase B endpoint', async () => {
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      VALID_BASE_URL,
      '/api/messaging/events',
    );
    const { app, queues } = buildAppStub();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 202 }));

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    await handler(makeJob());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${VALID_BASE_URL}/api/messaging/events`);
  });

  it('logs warn and returns (no throw, no fetch) when ATLAS_BASE_URL is unset mid-job', async () => {
    // Boot with secret set so the worker registers, but no base URL — the
    // handler-level re-check should trip and short-circuit without throwing.
    const { registerAtlasEventsWorker } = await loadFreshWorker(
      VALID_SECRET,
      undefined,
    );
    const { app, queues, log } = buildAppStub();
    const fetchImpl = vi.fn();

    registerAtlasEventsWorker(app, { fetchImpl });
    const handler = captureHandler(queues.registerWorker);

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    const lastWarn = log.warn.mock.calls.at(-1)![0];
    expect(lastWarn).toMatchObject({
      jobId: 'job-123',
      hasSecret: true,
      hasBaseUrl: false,
    });
  });

  describe('Phase 12.2 connector jobs', () => {
    /** Resolve the job's account to a connector whose emitDirect we control. */
    function stubConnector(emitDirect: ReturnType<typeof vi.fn>): void {
      connectorMock.getConnectorForAccount.mockResolvedValue({ emitDirect });
    }

    it('delivers a ConnectorEvent via emitDirect, bypassing the Phase B fetch', async () => {
      const { registerAtlasEventsWorker } = await loadFreshWorker(
        VALID_SECRET,
        VALID_BASE_URL,
      );
      const { app, queues, log } = buildAppStub();
      const emitDirect = vi.fn().mockResolvedValue(undefined);
      stubConnector(emitDirect);
      const fetchImpl = vi.fn();

      registerAtlasEventsWorker(app, { fetchImpl });
      const handler = captureHandler(queues.registerWorker);

      const job = makeConnectorJob();
      await handler(job);

      // emitDirect (SDK sign+POST+retry) gets the event verbatim; the Phase B
      // serialize+fetch path is never touched.
      expect(emitDirect).toHaveBeenCalledTimes(1);
      expect(emitDirect).toHaveBeenCalledWith(job.data);
      expect(fetchImpl).not.toHaveBeenCalled();
      const lastInfo = log.info.mock.calls.at(-1)![0];
      expect(lastInfo).toMatchObject({
        jobId: 'job-conn-1',
        eventId: 'msg_msg-xyz',
        kind: 'conversation_turn',
      });
    });

    it('marks complete (no rethrow) when emitDirect fails with a 4xx', async () => {
      const { registerAtlasEventsWorker } = await loadFreshWorker(
        VALID_SECRET,
        VALID_BASE_URL,
      );
      const { app, queues, log } = buildAppStub();
      const emitDirect = vi
        .fn()
        .mockRejectedValue(new ConnectorEmitFailedError(1, 400, 'invalid-signature'));
      stubConnector(emitDirect);

      registerAtlasEventsWorker(app, {});
      const handler = captureHandler(queues.registerWorker);

      // 4xx is terminal — won't fix itself, so don't let BullMQ loop.
      await expect(handler(makeConnectorJob())).resolves.toBeUndefined();
      expect(emitDirect).toHaveBeenCalledTimes(1);
      const lastWarn = log.warn.mock.calls.at(-1)![0];
      expect(lastWarn).toMatchObject({ jobId: 'job-conn-1', status: 400 });
    });

    it('rethrows on 5xx exhaustion so BullMQ retries then DLQs', async () => {
      const { registerAtlasEventsWorker } = await loadFreshWorker(
        VALID_SECRET,
        VALID_BASE_URL,
      );
      const { app, queues, log } = buildAppStub();
      const err = new ConnectorEmitFailedError(5, 502, 'bad gateway');
      const emitDirect = vi.fn().mockRejectedValue(err);
      stubConnector(emitDirect);

      registerAtlasEventsWorker(app, {});
      const handler = captureHandler(queues.registerWorker);

      await expect(handler(makeConnectorJob())).rejects.toBe(err);
      expect(log.warn).toHaveBeenCalled();
    });

    it('marks complete when a connector job arrives but its account has no connection', async () => {
      const { registerAtlasEventsWorker } = await loadFreshWorker(
        VALID_SECRET,
        VALID_BASE_URL,
      );
      const { app, queues, log } = buildAppStub();
      connectorMock.getConnectorForAccount.mockResolvedValue(null);

      registerAtlasEventsWorker(app, {});
      const handler = captureHandler(queues.registerWorker);

      await expect(handler(makeConnectorJob())).resolves.toBeUndefined();
      // Resolved by the job's metadata.accountId; null connection → no delivery.
      expect(connectorMock.getConnectorForAccount).toHaveBeenCalledWith(app, SOURCE_ACCOUNT_ID);
      const lastWarn = log.warn.mock.calls.at(-1)![0];
      expect(lastWarn).toMatchObject({
        jobId: 'job-conn-1',
        eventId: 'msg_msg-xyz',
      });
    });

    it('registers when only the connector is enabled, Phase B secret unset (C1 gate decouple)', async () => {
      const { registerAtlasEventsWorker } = await loadFreshWorker(
        undefined,
        undefined,
        undefined,
        true,
      );
      const { app, queues } = buildAppStub();

      registerAtlasEventsWorker(app, {});

      // Connector-on alone keeps the worker registered even with no Phase B
      // secret — Phase 10 dropping that secret must not kill connector delivery.
      expect(queues.registerWorker).toHaveBeenCalledTimes(1);
    });
  });
});
