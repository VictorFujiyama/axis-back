import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@blossom/db';
import type { ConnectorEvent } from '@atlas/connectors';

import type {
  RealtimeEvent,
  RealtimeMessage,
} from '../../../realtime/event-bus';

// Mock the T-004a builders: the connector-path tests verify listener WIRING
// (routing, account filter, dual-emit), not envelope shape — that is covered by
// build-connector-event.spec.ts (T-004b). The mocks let us drive a known
// `ConnectorEvent` (and its `metadata.accountId`) without DB fixtures.
const builderMocks = vi.hoisted(() => ({
  buildConversationTurnEvent: vi.fn(),
  buildConversationSummaryEvent: vi.fn(),
  buildHandoffEvent: vi.fn(),
  buildContactEvent: vi.fn(),
  buildLeadQualifiedEnvelope: vi.fn(),
}));
vi.mock('../build-connector-event', () => builderMocks);

// The connector leg now resolves a connection PER ACCOUNT (T-05). Mock the
// connection store so the REAL `getConnectorForAccount` builds a real connector
// (whose queueAdapter still calls queue.add, so the existing jobId=event_id
// assertions hold) without touching the DB or crypto. getConnection returns a
// connection by default; the anti-leak case overrides it to null.
const connectionsMock = vi.hoisted(() => ({ getConnection: vi.fn() }));
vi.mock('../connections', () => connectionsMock);

interface AppStub {
  app: FastifyInstance;
  queues: {
    getQueue: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
  };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

/**
 * Mock `app.db.select().from(...).where(...).limit(...)` chain. Each call to
 * `.limit()` resolves to the next row-set in `rowSets`. The build-envelope
 * helpers issue: 1) conversation, 2) inbox, 3) message (for message.created),
 * or 1) conversation, 2) inbox (for handoff / resolved). Phase B legacy mapping
 * does no DB lookup so rowSets is unused when envelopeMode='false'.
 */
function makeDb(rowSets: Array<unknown[]>): DB {
  const limit = vi.fn();
  for (const rs of rowSets) limit.mockResolvedValueOnce(rs);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as DB;
}

function buildAppStub(rowSets: Array<unknown[]> = []): AppStub {
  const add = vi.fn().mockResolvedValue(undefined);
  const getQueue = vi.fn().mockReturnValue({ add });
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  const app = {
    db: makeDb(rowSets),
    queues: { getQueue },
    log,
  } as unknown as FastifyInstance;
  return { app, queues: { getQueue, add }, log };
}

// Re-import config + enqueue per-test so config.ts (parsed at module load)
// reflects the current vi.stubEnv state. `envelopeMode` toggles the Phase 12
// envelope feature flag — describes pin it to 'true' (Phase 12 shape) or
// 'false' (Phase B literal). Mode-agnostic cases inherit the default 'true'.
interface ConnectorEnv {
  enabled: boolean;
}

async function loadFreshModules(
  secret: string | undefined,
  envelopeMode: 'true' | 'false' = 'true',
  connector?: ConnectorEnv,
) {
  vi.resetModules();
  if (secret === undefined) {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', '');
    // Empty-string env vars still satisfy z.string().optional() as "set" — clear
    // them so the schema sees undefined.
    delete process.env.ATLAS_EVENTS_HMAC_SECRET;
  } else {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', secret);
  }
  vi.stubEnv('USE_PHASE_12_ENVELOPE', envelopeMode);
  if (connector?.enabled) {
    // ATLAS_URL alone is the connector master switch now (Connect Flow T-10):
    // org/secret/source-account are resolved per-account, not from boot env.
    vi.stubEnv('ATLAS_URL', CONNECTOR_URL);
  }
  const eventBusModule = await import('../../../realtime/event-bus');
  const enqueueModule = await import('../enqueue');
  return {
    eventBus: eventBusModule.eventBus,
    subscribeAtlasEvents: enqueueModule.subscribeAtlasEvents,
  };
}

function makeMessage(overrides: Partial<RealtimeMessage> = {}): RealtimeMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    inboxId: 'inbox-1',
    senderType: 'contact',
    senderId: 'contact-1',
    content: 'hello world',
    contentType: 'text',
    mediaUrl: null,
    mediaMimeType: null,
    isPrivateNote: false,
    createdAt: new Date('2026-05-11T12:00:00Z'),
    ...overrides,
  };
}

async function flushMicrotasks() {
  // Helpers chain three awaits (conversation, inbox, message). setImmediate
  // fires after the entire microtask queue drains so all chained promise
  // resolutions complete before the assertion.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const VALID_SECRET = 'a'.repeat(64);

// Phase 12.2 connector env fixtures (must be schema-valid: uuid / url / min-len).
const SOURCE_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';
const HMAC_SECRET = 'b'.repeat(48);
const CONNECTOR_URL = 'https://atlas-company-os.vercel.app';

/** A stand-in `ConnectorEvent` for the builder mocks. The emit path reads only
 * `event_id`; the listener's anti-leak filter reads `metadata.accountId` (which
 * defaults to the source account so it passes — override it to force a drop). */
function fakeConnectorEvent(overrides: Partial<ConnectorEvent> = {}): ConnectorEvent {
  return {
    event_id: 'msg_msg-xyz',
    kind: 'conversation_turn',
    metadata: { accountId: SOURCE_ACCOUNT_ID },
    ...overrides,
  } as ConnectorEvent;
}

/** A decrypted `atlas_connections` view (the shape `getConnection` returns).
 * `getConnectorForAccount` reads `atlasOrgId` + `secrets.hmacSecret` off it to
 * build the per-account connector; `emitConnectorEvent` reads `atlasOrgId` for
 * the envelope's `org_id`. */
function fakeConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atlas-conn-1',
    atlasAccountId: SOURCE_ACCOUNT_ID,
    atlasOrgId: ORG_ID,
    status: 'active' as const,
    secrets: { hmacSecret: HMAC_SECRET, mcpBearer: 'mcp-bearer-xyz' },
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** Inbox → accountId row consumed by the listener's per-account resolution
 * (`resolveEventAccountId` maps a conversation event's `inboxId` to its axis
 * account before the connection lookup). */
const inboxAccountRow = { accountId: SOURCE_ACCOUNT_ID };

const convRow = {
  id: 'conv-abc',
  inboxId: 'inbox-1',
  contactId: 'contact-1',
  assignedUserId: 'user-1',
  assignedTeamId: null as string | null,
};
const inboxRow = { id: 'inbox-1', accountId: 'account-1' };

// [autonomy-T-18] The smart-handoff gate reads `(assignedBotId, assignedUserId)`
// off the conversation BEFORE either delivery leg runs, for contact turns only.
// This stand-in row represents a bot-managed, human-free conversation — the one
// state where a contact turn still flows. Prepended as the first row-set in the
// message.created cases so the gate lets them through unchanged.
const botManagedConvRow = { assignedBotId: 'bot-1', assignedUserId: null as string | null };

describe('subscribeAtlasEvents', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // --- mode-agnostic cases: behavior identical across USE_PHASE_12_ENVELOPE ---

  it('does not subscribe when ATLAS_EVENTS_HMAC_SECRET is unset', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined);
    const onEventSpy = vi.spyOn(eventBus, 'onEvent');
    const { app, queues, log } = buildAppStub();

    subscribeAtlasEvents(app);

    expect(onEventSpy).not.toHaveBeenCalled();
    expect(queues.getQueue).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();

    // Emitting after the no-op subscribe should not enqueue anything.
    eventBus.emitEvent({
      type: 'message.created',
      inboxId: 'inbox-1',
      conversationId: 'conv-1',
      message: makeMessage(),
    });
    await flushMicrotasks();
    expect(queues.add).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when conversation.assigned has a non-null assignedBotId', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
    const { app, queues } = buildAppStub();

    subscribeAtlasEvents(app);

    const event: RealtimeEvent = {
      type: 'conversation.assigned',
      inboxId: 'inbox-1',
      conversationId: 'conv-bot',
      assignedUserId: null,
      assignedTeamId: null,
      assignedBotId: 'bot-77',
    };
    eventBus.emitEvent(event);
    await flushMicrotasks();

    expect(queues.add).not.toHaveBeenCalled();
  });

  // --- [autonomy-T-18] smart-handoff assignment gate (spec Fase G, D28) ---
  // A contact's inbound turn reaches Atlas ONLY while the conversation is
  // bot-managed and human-free. The gate runs ahead of both delivery legs, so
  // these exercise it through the Phase 12 envelope leg.
  describe('contact turn assignment gate', () => {
    const msgRow = {
      id: 'msg-xyz',
      conversationId: 'conv-abc',
      senderType: 'contact',
      senderId: 'contact-1',
      content: 'hello world',
      createdAt: new Date('2026-05-11T12:00:00Z'),
    };

    function emitContactTurn(eventBus: { emitEvent: (e: RealtimeEvent) => void }) {
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: 'inbox-1',
        conversationId: 'conv-abc',
        message: makeMessage({ id: 'msg-xyz', senderType: 'contact', content: 'hello world' }),
      });
    }

    it('dispatches when a bot is assigned and no human (assignedBotId set, assignedUserId null)', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET, 'true');
      // gate row (bot-managed) → then envelope builders: conv, inbox, message.
      const { app, queues } = buildAppStub([
        [{ assignedBotId: 'bot-1', assignedUserId: null }],
        [convRow],
        [inboxRow],
        [msgRow],
      ]);

      subscribeAtlasEvents(app);
      emitContactTurn(eventBus);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      expect(queues.add.mock.calls[0]![0]).toBe('conversation_turn');
    });

    it('skips when a human is assigned (assignedBotId null, assignedUserId set)', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET, 'true');
      // Only the gate row is consumed — the skip short-circuits before any build.
      const { app, queues } = buildAppStub([
        [{ assignedBotId: null, assignedUserId: 'user-9' }],
      ]);

      subscribeAtlasEvents(app);
      emitContactTurn(eventBus);
      await flushMicrotasks();

      expect(queues.add).not.toHaveBeenCalled();
    });

    it('skips when nobody owns the conversation (assignedBotId null, assignedUserId null)', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET, 'true');
      const { app, queues } = buildAppStub([
        [{ assignedBotId: null, assignedUserId: null }],
      ]);

      subscribeAtlasEvents(app);
      emitContactTurn(eventBus);
      await flushMicrotasks();

      expect(queues.add).not.toHaveBeenCalled();
    });

    it('skips when both a bot and a human are assigned — human precedes (bizarre state)', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET, 'true');
      const { app, queues } = buildAppStub([
        [{ assignedBotId: 'bot-1', assignedUserId: 'user-9' }],
      ]);

      subscribeAtlasEvents(app);
      emitContactTurn(eventBus);
      await flushMicrotasks();

      expect(queues.add).not.toHaveBeenCalled();
    });
  });

  // --- envelope-shape cases ---

  describe('USE_PHASE_12_ENVELOPE=true', () => {
    it('enqueues conversation_turn envelope on message.created', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(
        VALID_SECRET,
        'true',
      );
      const msgRow = {
        id: 'msg-xyz',
        conversationId: 'conv-abc',
        senderType: 'contact',
        senderId: 'contact-1',
        content: 'hello world',
        createdAt: new Date('2026-05-11T12:00:00Z'),
      };
      const { app, queues } = buildAppStub([
        [botManagedConvRow],
        [convRow],
        [inboxRow],
        [msgRow],
      ]);

      subscribeAtlasEvents(app);

      expect(queues.getQueue).toHaveBeenCalledWith('atlas-events');

      const event: RealtimeEvent = {
        type: 'message.created',
        inboxId: 'inbox-1',
        conversationId: 'conv-abc',
        message: makeMessage({
          id: 'msg-xyz',
          senderType: 'contact',
          content: 'hello world',
        }),
      };
      eventBus.emitEvent(event);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('conversation_turn');
      expect(payload).toMatchObject({
        kind: 'conversation_turn',
        action: 'create',
        sourceRef: 'conv-abc:message_sent:msg-xyz',
        accountId: 'account-1',
        summary: 'contact: hello world',
        actors: [{ kind: 'contact', id: 'contact-1' }],
        viewableBy: { scope: 'org' },
      });
      expect(opts).toEqual({ jobId: 'conv-abc:message_sent:msg-xyz' });
    });

    it('enqueues handoff conversation_turn envelope when conversation.assigned has assignedBotId === null', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(
        VALID_SECRET,
        'true',
      );
      const handoffConv = { ...convRow, id: 'conv-handoff' };
      const { app, queues } = buildAppStub([[handoffConv], [inboxRow]]);

      subscribeAtlasEvents(app);

      const event: RealtimeEvent = {
        type: 'conversation.assigned',
        inboxId: 'inbox-1',
        conversationId: 'conv-handoff',
        assignedUserId: 'user-99',
        assignedTeamId: null,
        assignedBotId: null,
      };
      eventBus.emitEvent(event);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('conversation_turn');
      expect(payload).toMatchObject({
        kind: 'conversation_turn',
        action: 'update',
        accountId: 'account-1',
        summary: 'Handoff: bot → user',
        actors: [],
        viewableBy: { scope: 'org' },
      });
      const jobOpts = opts as { jobId: string };
      expect(jobOpts.jobId).toMatch(/^conv-handoff:handoff:\d+$/);
      expect((payload as { sourceRef: string }).sourceRef).toBe(jobOpts.jobId);
    });

    it('enqueues resolved conversation_turn envelope on conversation.resolved', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(
        VALID_SECRET,
        'true',
      );
      const resolvedConv = { ...convRow, id: 'conv-res' };
      const { app, queues } = buildAppStub([[resolvedConv], [inboxRow]]);

      subscribeAtlasEvents(app);

      const event: RealtimeEvent = {
        type: 'conversation.resolved',
        inboxId: 'inbox-1',
        conversationId: 'conv-res',
        resolvedBy: 'user-1',
      };
      eventBus.emitEvent(event);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('conversation_turn');
      expect(payload).toMatchObject({
        kind: 'conversation_turn',
        action: 'update',
        sourceRef: 'conv-res:resolved',
        accountId: 'account-1',
        summary: 'Resolved',
        actors: [],
      });
      expect(opts).toEqual({ jobId: 'conv-res:resolved' });
    });
  });

  describe('USE_PHASE_12_ENVELOPE=false', () => {
    it('enqueues Phase B message_sent legacy job on message.created', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(
        VALID_SECRET,
        'false',
      );
      // [autonomy-T-18] gate reads the conversation first; bot-managed → passes.
      const { app, queues } = buildAppStub([[botManagedConvRow]]);

      subscribeAtlasEvents(app);

      expect(queues.getQueue).toHaveBeenCalledWith('atlas-events');

      const event: RealtimeEvent = {
        type: 'message.created',
        inboxId: 'inbox-1',
        conversationId: 'conv-abc',
        message: makeMessage({
          id: 'msg-xyz',
          senderType: 'contact',
          content: 'hello world',
        }),
      };
      eventBus.emitEvent(event);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('message_sent');
      expect(payload).toMatchObject({
        type: 'message_sent',
        conversationId: 'conv-abc',
        messageId: 'msg-xyz',
        summary: 'contact: hello world',
      });
      expect((payload as { occurredAt: string }).occurredAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
      expect(payload).not.toHaveProperty('kind');
      expect(opts).toEqual({ jobId: 'conv-abc:message_sent:msg-xyz' });
    });

    it('enqueues Phase B handoff_to_human legacy job when conversation.assigned has assignedBotId === null', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(
        VALID_SECRET,
        'false',
      );
      const { app, queues } = buildAppStub();

      subscribeAtlasEvents(app);

      const event: RealtimeEvent = {
        type: 'conversation.assigned',
        inboxId: 'inbox-1',
        conversationId: 'conv-handoff',
        assignedUserId: 'user-99',
        assignedTeamId: null,
        assignedBotId: null,
      };
      eventBus.emitEvent(event);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('handoff_to_human');
      expect(payload).toMatchObject({
        type: 'handoff_to_human',
        conversationId: 'conv-handoff',
        assignedUserId: 'user-99',
        assignedTeamId: null,
        summary: 'Handoff: bot → user',
      });
      expect(payload).not.toHaveProperty('kind');
      const jobOpts = opts as { jobId: string };
      expect(jobOpts.jobId).toMatch(/^conv-handoff:handoff:\d+$/);
    });

    it('enqueues Phase B conversation_resolved legacy job on conversation.resolved', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(
        VALID_SECRET,
        'false',
      );
      const { app, queues } = buildAppStub();

      subscribeAtlasEvents(app);

      const event: RealtimeEvent = {
        type: 'conversation.resolved',
        inboxId: 'inbox-1',
        conversationId: 'conv-res',
        resolvedBy: 'user-1',
      };
      eventBus.emitEvent(event);
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('conversation_resolved');
      expect(payload).toMatchObject({
        type: 'conversation_resolved',
        conversationId: 'conv-res',
        summary: 'Resolved',
      });
      expect(payload).not.toHaveProperty('messageId');
      expect(payload).not.toHaveProperty('kind');
      expect(opts).toEqual({ jobId: 'conv-res:resolved' });
    });
  });

  describe('connector path (per-account)', () => {
    beforeEach(() => {
      builderMocks.buildConversationTurnEvent.mockReset();
      builderMocks.buildConversationSummaryEvent.mockReset();
      builderMocks.buildHandoffEvent.mockReset();
      builderMocks.buildContactEvent.mockReset();
      builderMocks.buildLeadQualifiedEnvelope.mockReset();
      connectionsMock.getConnection.mockReset();
      // Default: the resolved account HAS a connection. The anti-leak case below
      // overrides it to null (no connection → no emit).
      connectionsMock.getConnection.mockResolvedValue(fakeConnection());
    });

    // No Phase B secret here → proves the C1 gate decouple (Phase 10 shape).
    it('emits a ConnectorEvent on message.created with jobId=event_id, no Phase B secret', async () => {
      builderMocks.buildConversationTurnEvent.mockResolvedValue(fakeConnectorEvent());
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      // [autonomy-T-18] gate row first (bot-managed → passes), then rowSet feeds
      // resolveEventAccountId's inbox → accountId lookup.
      const { app, queues } = buildAppStub([[botManagedConvRow], [inboxAccountRow]]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: 'inbox-1',
        conversationId: 'conv-abc',
        message: makeMessage({ id: 'msg-xyz' }),
      });
      await flushMicrotasks();

      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, payload, opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('atlas-events');
      expect((payload as ConnectorEvent).event_id).toBe('msg_msg-xyz');
      expect(opts).toEqual({ jobId: 'msg_msg-xyz' });
    });

    it('routes contact.created to buildContactEvent (with the connection orgId) and emits', async () => {
      builderMocks.buildContactEvent.mockResolvedValue(
        fakeConnectorEvent({ kind: 'contact', event_id: 'contact_c-1' }),
      );
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      // contact.created carries accountId directly → no inbox lookup needed.
      const { app, queues } = buildAppStub();

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'contact.created',
        accountId: SOURCE_ACCOUNT_ID,
        contact: { id: 'c-1', name: 'Jo', email: 'jo@x.com', phone: null, createdAt: new Date() },
      });
      await flushMicrotasks();

      expect(builderMocks.buildContactEvent).toHaveBeenCalledWith(app.db, {
        contactId: 'c-1',
        orgId: ORG_ID,
      });
      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, , opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('atlas-events');
      expect(opts).toEqual({ jobId: 'contact_c-1' });
    });

    // Anti-leak (spec G5): an account with NO connection drops BEFORE building —
    // no global ATLAS_SOURCE_ACCOUNT_ID compare, the builder is never called.
    it('drops the event when the account has no connection (no emit, no build)', async () => {
      connectionsMock.getConnection.mockResolvedValue(null);
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      const { app, queues } = buildAppStub();

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'contact.created',
        accountId: OTHER_ACCOUNT_ID,
        contact: { id: 'c-9', name: 'X', email: null, phone: null, createdAt: new Date() },
      });
      await flushMicrotasks();

      expect(builderMocks.buildContactEvent).not.toHaveBeenCalled();
      expect(queues.add).not.toHaveBeenCalled();
    });

    // Listeners #2 resolved→summary, #3 assigned→handoff (+ bot-assigned skip).
    it('routes conversation.resolved→summary and conversation.assigned(bot→human)→handoff', async () => {
      builderMocks.buildConversationSummaryEvent.mockResolvedValue(
        fakeConnectorEvent({ kind: 'conversation_summary', event_id: 'conv_conv-res:resolved' }),
      );
      builderMocks.buildHandoffEvent.mockResolvedValue(
        fakeConnectorEvent({ kind: 'handoff_to_human', event_id: 'conv_conv-h:handoff:1' }),
      );
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      // Two inbox lookups: resolved + human-assigned. The bot-assigned event
      // short-circuits in resolveEventAccountId (no inbox query).
      const { app, queues } = buildAppStub([[inboxAccountRow], [inboxAccountRow]]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'conversation.resolved',
        inboxId: 'inbox-1',
        conversationId: 'conv-res',
        resolvedBy: 'user-1',
      });
      // bot-assigned → no handoff (assignedBotId !== null)
      eventBus.emitEvent({
        type: 'conversation.assigned',
        inboxId: 'inbox-1',
        conversationId: 'conv-bot',
        assignedUserId: null,
        assignedTeamId: null,
        assignedBotId: 'bot-1',
      });
      eventBus.emitEvent({
        type: 'conversation.assigned',
        inboxId: 'inbox-1',
        conversationId: 'conv-h',
        assignedUserId: 'user-9',
        assignedTeamId: null,
        assignedBotId: null,
      });
      await flushMicrotasks();

      expect(builderMocks.buildConversationSummaryEvent).toHaveBeenCalledWith(app.db, {
        conversationId: 'conv-res',
        orgId: ORG_ID,
      });
      expect(builderMocks.buildHandoffEvent).toHaveBeenCalledTimes(1);
      expect(builderMocks.buildHandoffEvent).toHaveBeenCalledWith(app.db, {
        conversationId: 'conv-h',
        orgId: ORG_ID,
      });
      expect(queues.add).toHaveBeenCalledTimes(2); // summary + handoff (bot-assigned dropped)
    });

    // [crm-T-03] conversation.tagged → buildLeadQualifiedEnvelope when the tag
    // name is `qualified` (case-insensitive, D3). Three rowSets are consumed:
    //   1) resolveEventAccountId — inbox → accountId
    //   2) buildConnectorEventForEvent — tag → name lookup
    //   3) buildConnectorEventForEvent — inbox → accountId (re-resolved so the
    //      builder gets the value via input.accountId, not via DB join)
    it('routes conversation.tagged with tag name "qualified" to buildLeadQualifiedEnvelope and emits', async () => {
      builderMocks.buildLeadQualifiedEnvelope.mockResolvedValue(
        fakeConnectorEvent({
          kind: 'lead_qualified',
          event_id: 'conv_conv-q:lead_qualified:1748520000000',
        }),
      );
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      const { app, queues } = buildAppStub([
        [inboxAccountRow],
        [{ name: 'qualified' }],
        [inboxAccountRow],
      ]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'conversation.tagged',
        inboxId: 'inbox-1',
        conversationId: 'conv-q',
        tagId: 'tag-q',
        taggedAt: '2026-05-29T12:00:00.000Z',
      });
      await flushMicrotasks();

      expect(builderMocks.buildLeadQualifiedEnvelope).toHaveBeenCalledTimes(1);
      expect(builderMocks.buildLeadQualifiedEnvelope).toHaveBeenCalledWith(app.db, {
        conversationId: 'conv-q',
        accountId: SOURCE_ACCOUNT_ID,
        orgId: ORG_ID,
        taggedAt: '2026-05-29T12:00:00.000Z',
      });
      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, , opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('atlas-events');
      expect(opts).toEqual({ jobId: 'conv_conv-q:lead_qualified:1748520000000' });
    });

    // [crm-T-03] D3 case-insensitive contract: `Qualified` (capitalized) MUST
    // still route to the builder so a UI that title-cases tag names doesn't
    // silently miss the qualifying signal.
    it('routes conversation.tagged with tag name "Qualified" (mixed case) to buildLeadQualifiedEnvelope', async () => {
      builderMocks.buildLeadQualifiedEnvelope.mockResolvedValue(
        fakeConnectorEvent({ kind: 'lead_qualified', event_id: 'conv_conv-q:lead_qualified:1' }),
      );
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      const { app, queues } = buildAppStub([
        [inboxAccountRow],
        [{ name: 'Qualified' }],
        [inboxAccountRow],
      ]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'conversation.tagged',
        inboxId: 'inbox-1',
        conversationId: 'conv-q',
        tagId: 'tag-q',
        taggedAt: '2026-05-29T12:00:00.000Z',
      });
      await flushMicrotasks();

      expect(builderMocks.buildLeadQualifiedEnvelope).toHaveBeenCalledTimes(1);
      expect(queues.add).toHaveBeenCalledTimes(1);
    });

    // [crm-T-03] Non-qualifying tags emit on the bus for forward-compat
    // (future kinds) but produce no envelope — the connector leg drops them.
    it('drops conversation.tagged when the tag name is not "qualified"', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      // 2 rowSets: resolveEventAccountId + tag name lookup (early return after).
      const { app, queues } = buildAppStub([
        [inboxAccountRow],
        [{ name: 'follow-up' }],
      ]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'conversation.tagged',
        inboxId: 'inbox-1',
        conversationId: 'conv-x',
        tagId: 'tag-x',
        taggedAt: '2026-05-29T12:00:00.000Z',
      });
      await flushMicrotasks();

      expect(builderMocks.buildLeadQualifiedEnvelope).not.toHaveBeenCalled();
      expect(queues.add).not.toHaveBeenCalled();
    });

    // [crm-T-03] Defensive: if the tag row vanished between insert and the
    // listener's lookup (rare delete race), the builder must NOT be invoked.
    it('drops conversation.tagged when the tag row no longer exists', async () => {
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(undefined, 'false', {
        enabled: true,
      });
      const { app, queues } = buildAppStub([[inboxAccountRow], []]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'conversation.tagged',
        inboxId: 'inbox-1',
        conversationId: 'conv-x',
        tagId: 'tag-gone',
        taggedAt: '2026-05-29T12:00:00.000Z',
      });
      await flushMicrotasks();

      expect(builderMocks.buildLeadQualifiedEnvelope).not.toHaveBeenCalled();
      expect(queues.add).not.toHaveBeenCalled();
    });

    // Connector-only (Phase 10, dual-emit retired): with the connector on
    // (ATLAS_URL set) the Phase B leg is suppressed even when its secret is set.
    it('suppresses the Phase B leg when the connector is on, even with the secret set', async () => {
      builderMocks.buildConversationTurnEvent.mockResolvedValue(fakeConnectorEvent());
      const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET, 'false', {
        enabled: true,
      });
      // [autonomy-T-18] gate row first (bot-managed → passes).
      const { app, queues } = buildAppStub([[botManagedConvRow], [inboxAccountRow]]);

      subscribeAtlasEvents(app);
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: 'inbox-1',
        conversationId: 'conv-abc',
        message: makeMessage({ id: 'msg-xyz', senderType: 'contact', content: 'hello world' }),
      });
      await flushMicrotasks();

      // Only the connector job — no Phase B legacy job.
      expect(queues.add).toHaveBeenCalledTimes(1);
      const [name, , opts] = queues.add.mock.calls[0]!;
      expect(name).toBe('atlas-events'); // connector only
      expect((opts as { jobId: string }).jobId).toBe('msg_msg-xyz'); // connector keyspace
    });
  });
});
