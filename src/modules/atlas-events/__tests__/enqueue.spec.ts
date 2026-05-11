import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

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

function buildAppStub(): AppStub {
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
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const VALID_SECRET = 'a'.repeat(64);

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

  it('enqueues message_sent with deterministic jobId on message.created', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
    const { app, queues } = buildAppStub();

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
    expect(typeof (payload as { occurredAt: string }).occurredAt).toBe('string');
    expect(opts).toEqual({ jobId: 'conv-abc:message_sent:msg-xyz' });
  });

  it('enqueues handoff_to_human when conversation.assigned has assignedBotId === null', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
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
    expect(opts).toBeDefined();
    const jobOpts = opts as { jobId: string };
    expect(jobOpts.jobId).toMatch(/^conv-handoff:handoff:\d+$/);
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

  it('enqueues conversation_resolved on conversation.resolved', async () => {
    const { eventBus, subscribeAtlasEvents } = await loadFreshModules(VALID_SECRET);
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
    expect(opts).toEqual({ jobId: 'conv-res:resolved' });
  });
});
