import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@blossom/db';

import type {
  RealtimeEvent,
  RealtimeMessage,
} from '../../../realtime/event-bus';

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
 * or 1) conversation, 2) inbox (for handoff / resolved).
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

// Re-import config + enqueue module per-test so that `config.ATLAS_EVENTS_HMAC_SECRET`
// reflects the current vi.stubEnv state (config.ts parses process.env at module
// load time). Mirrors the loadFreshConfig pattern in src/__tests__/config.spec.ts.
async function loadFreshModules(secret: string | undefined) {
  vi.resetModules();
  if (secret === undefined) {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', '');
    // Empty-string env vars still satisfy z.string().optional() as "set" — clear
    // them so the schema sees undefined.
    delete process.env.ATLAS_EVENTS_HMAC_SECRET;
  } else {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', secret);
  }
  // T-006 flipped USE_PHASE_12_ENVELOPE default to false; legacy cases below
  // assert Phase 12 envelope shape, so stub the flag on. T-007 will reorganize
  // the suite into nested describes per mode and add Phase B mirror cases.
  vi.stubEnv('USE_PHASE_12_ENVELOPE', 'true');
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

const convRow = {
  id: 'conv-abc',
  inboxId: 'inbox-1',
  contactId: 'contact-1',
  assignedUserId: 'user-1',
  assignedTeamId: null as string | null,
};
const inboxRow = { id: 'inbox-1', accountId: 'account-1' };

describe('subscribeAtlasEvents', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

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

  it('enqueues conversation_turn envelope on message.created', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
    const msgRow = {
      id: 'msg-xyz',
      conversationId: 'conv-abc',
      senderType: 'contact',
      senderId: 'contact-1',
      content: 'hello world',
      createdAt: new Date('2026-05-11T12:00:00Z'),
    };
    const { app, queues } = buildAppStub([[convRow], [inboxRow], [msgRow]]);

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
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
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

  it('enqueues resolved conversation_turn envelope on conversation.resolved', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
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
