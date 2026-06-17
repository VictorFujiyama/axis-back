import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eventBus, type RealtimeEvent } from '../event-bus';

// T-26: GET /ws/widget — the visitor realtime socket. Covers token audience auth,
// the hello payload, forwarding agent replies only for owned conversations,
// typing-indicator ownership, and token-expiry teardown. The route handler is
// captured off a fake app so we exercise it without a live socket/server.

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const CONTACT_ID = '22222222-3333-4444-8555-666666666666';
const CONV_ID = '11111111-2222-4333-8444-555555555555';
const VISITOR_ID = `vis_${'a'.repeat(32)}`;

type WsHandler = (socket: FakeSocket, req: { url: string; headers: Record<string, unknown> }) => Promise<void>;

class FakeSocket extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  terminated = false;
  pinged = 0;
  bufferedAmount = 0;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    if (!this.closed) this.closed = { code, reason };
  }
  ping(): void {
    this.pinged++;
  }
  terminate(): void {
    this.terminated = true;
  }
}

interface BuildOpts {
  results?: unknown[];
  presence?: Record<string, 'online' | 'busy' | 'offline'>;
}

async function buildHandler(
  opts: BuildOpts = {},
): Promise<{ handler: WsHandler; jwt: FastifyInstance['jwt']; close: () => Promise<void> }> {
  const Fastify = (await import('fastify')).default;
  const { default: jwtPlugin } = await import('../../plugins/jwt');
  const { widgetWsRoutes } = await import('../widget-ws');

  const realApp = Fastify({ logger: false });
  await realApp.register(jwtPlugin);
  await realApp.ready();

  const results = opts.results ?? [
    [{ id: CONV_ID, status: 'open' }],
    [{ name: 'Ana', email: null }],
    [{ accountId: null, config: { widgetToken: 'wt_test' } }],
    [],
  ];
  let call = 0;
  const select = (): Record<string, unknown> => {
    const idx = call++;
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.innerJoin = () => q;
    q.orderBy = () => q;
    q.limit = () => Promise.resolve(results[idx] ?? []);
    q.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(results[idx] ?? []).then(onF, onR);
    return q;
  };

  let handler: WsHandler | undefined;
  const fakeApp = {
    get: (_path: string, _opts: unknown, h: WsHandler) => {
      handler = h;
    },
    jwt: realApp.jwt,
    log: realApp.log,
    db: { select },
    presence: { getAvailableUsers: async () => opts.presence ?? {} },
  } as unknown as FastifyInstance;

  await widgetWsRoutes(fakeApp);
  if (!handler) throw new Error('handler not registered');
  return { handler, jwt: realApp.jwt, close: () => realApp.close() };
}

function widgetToken(jwt: FastifyInstance['jwt'], over: Record<string, unknown> = {}): string {
  return jwt.sign(
    { aud: 'widget', inboxId: INBOX_ID, contactId: CONTACT_ID, visitorId: VISITOR_ID, ...over } as never,
    { expiresIn: '12h' },
  );
}

function req(token?: string): { url: string; headers: Record<string, unknown> } {
  return {
    url: token ? `/ws/widget?token=${token}` : '/ws/widget',
    headers: { host: 'localhost' },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('GET /ws/widget (T-26)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('closes with 4401 when the token is missing', async () => {
    const { handler, close } = await buildHandler();
    try {
      const socket = new FakeSocket();
      await handler(socket, req());
      expect(socket.closed?.code).toBe(4401);
    } finally {
      await close();
    }
  });

  it('closes with 4401 when the token is invalid', async () => {
    const { handler, close } = await buildHandler();
    try {
      const socket = new FakeSocket();
      await handler(socket, req('garbage.token.here'));
      expect(socket.closed?.code).toBe(4401);
    } finally {
      await close();
    }
  });

  it('closes with 4403 when the audience is wrong', async () => {
    const { handler, jwt, close } = await buildHandler();
    try {
      const socket = new FakeSocket();
      await handler(socket, req(widgetToken(jwt, { aud: 'agent' })));
      expect(socket.closed?.code).toBe(4403);
    } finally {
      await close();
    }
  });

  it('sends a hello with the latest conversation and team availability', async () => {
    const { handler, jwt, close } = await buildHandler({
      results: [
        [{ id: CONV_ID, status: 'open' }],
        [{ name: 'Ana', email: null }],
        [{ accountId: 'acc-1', config: { widgetToken: 'wt_test' } }],
        [],
      ],
      presence: {},
    });
    try {
      const socket = new FakeSocket();
      await handler(socket, req(widgetToken(jwt)));
      socket.emit('close');
      const hello = socket.sent[0]!;
      expect(hello.type).toBe('hello');
      expect(hello.conversationId).toBe(CONV_ID);
      expect(hello.availability).toBe('away');
    } finally {
      await close();
    }
  });

  it('forwards an agent reply in an owned conversation', async () => {
    const { handler, jwt, close } = await buildHandler();
    try {
      const socket = new FakeSocket();
      await handler(socket, req(widgetToken(jwt)));
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: INBOX_ID,
        conversationId: CONV_ID,
        message: { senderType: 'agent', senderId: 'agent-1', isPrivateNote: false } as never,
      } as RealtimeEvent);
      await tick();
      socket.emit('close');
      expect(socket.sent.some((m) => m.type === 'message.created')).toBe(true);
    } finally {
      await close();
    }
  });

  it('does not forward a private note', async () => {
    const { handler, jwt, close } = await buildHandler();
    try {
      const socket = new FakeSocket();
      await handler(socket, req(widgetToken(jwt)));
      eventBus.emitEvent({
        type: 'message.created',
        inboxId: INBOX_ID,
        conversationId: CONV_ID,
        message: { senderType: 'agent', senderId: 'agent-1', isPrivateNote: true } as never,
      } as RealtimeEvent);
      await tick();
      socket.emit('close');
      expect(socket.sent.some((m) => m.type === 'message.created')).toBe(false);
    } finally {
      await close();
    }
  });

  it('emits typing only for a conversation the visitor owns', async () => {
    const { handler, jwt, close } = await buildHandler();
    const seen: string[] = [];
    const unsub = eventBus.onEvent((e) => {
      if (e.type === 'typing.indicator') seen.push(e.conversationId);
    });
    try {
      const socket = new FakeSocket();
      await handler(socket, req(widgetToken(jwt)));
      socket.emit('message', { toString: () => JSON.stringify({ type: 'typing', conversationId: CONV_ID }) });
      socket.emit('message', {
        toString: () => JSON.stringify({ type: 'typing', conversationId: '00000000-0000-4000-8000-000000000000' }),
      });
      await tick();
      socket.emit('close');
      expect(seen).toContain(CONV_ID);
      expect(seen).not.toContain('00000000-0000-4000-8000-000000000000');
    } finally {
      unsub();
      await close();
    }
  });

  it('closes the socket once the token has expired', async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const { handler, jwt, close } = await buildHandler();
    try {
      const socket = new FakeSocket();
      const token = jwt.sign(
        { aud: 'widget', inboxId: INBOX_ID, contactId: CONTACT_ID, visitorId: VISITOR_ID } as never,
        { expiresIn: '60s' },
      );
      await handler(socket, req(token));
      expect(socket.sent[0]?.type).toBe('hello');
      vi.advanceTimersByTime(70_000);
      socket.emit('close');
      expect(socket.closed?.code).toBe(4401);
    } finally {
      vi.useRealTimers();
      await close();
    }
  });
});
