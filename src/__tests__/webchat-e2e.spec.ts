import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eventBus, type RealtimeEvent } from '../realtime/event-bus';

// T-27: end-to-end visitor lifecycle across the public widget surface. One flow
// threads the server-issued visitorId / contactId / conversationId through every
// step: /session -> /webhooks/webchat (send) -> /ws/widget (hello + agent reply
// + resolve) -> /csat -> /attachment. The DB and ingest layers are stubbed, but
// the identifiers genuinely flow from one response into the next request.

vi.mock('../modules/channels/post-ingest', () => ({
  ingestWithHooks: vi.fn(),
}));

vi.mock('../lib/storage', () => ({
  uploadFile: vi.fn(async () => ({ url: 'https://r2.example/uploads/x.png', key: 'k' })),
  reserveWriteSlot: vi.fn(async () => ({ used: 1, limit: 100 })),
  StorageQuotaExceeded: class StorageQuotaExceeded extends Error {},
}));

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const WIDGET_TOKEN = 'wt_test';
const ACCOUNT_ID = '33333333-4444-4555-8666-777777777777';
const CONTACT_ID = '22222222-3333-4444-8555-666666666666';
const CONV_ID = '11111111-2222-4333-8444-555555555555';
const BOUNDARY = '----webchate2eboundary';

function inboxRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, primaryColor: '#7b3fa9', ...configOverrides },
    secrets: null as string | null,
    defaultBotId: null as string | null,
    enabled: true,
    deletedAt: null as Date | null,
  };
}

// Channel app (HTTP routes) with a call-index-keyed select queue, an insert that
// returns CONTACT_ID, and an update no-op — same harness shape as the unit specs.
async function buildChannelApp(results: unknown[]): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../plugins/jwt');
  const { webchatChannelRoutes } = await import('../modules/channels/webchat-webhook');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const idx = call++;
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.innerJoin = () => q;
    q.limit = () => Promise.resolve(results[idx] ?? []);
    return q;
  });
  const insert = vi.fn().mockImplementation(() => ({
    values: () => {
      const p = Promise.resolve([{ id: CONTACT_ID }]);
      return { returning: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
    },
  }));
  const update = vi.fn().mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  }));

  app.decorate('db', { select, insert, update } as unknown as FastifyInstance['db']);
  app.decorate('redis', {} as unknown as FastifyInstance['redis']);

  await app.register(webchatChannelRoutes);
  await app.ready();
  return app;
}

type WsHandler = (
  socket: FakeSocket,
  req: { url: string; headers: Record<string, unknown> },
) => Promise<void>;

class FakeSocket extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedAmount = 0;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    if (!this.closed) this.closed = { code, reason };
  }
  ping(): void {}
  terminate(): void {}
}

async function buildWsHandler(
  results: unknown[],
): Promise<{ handler: WsHandler; close: () => Promise<void> }> {
  const Fastify = (await import('fastify')).default;
  const { default: jwtPlugin } = await import('../plugins/jwt');
  const { widgetWsRoutes } = await import('../realtime/widget-ws');

  const realApp = Fastify({ logger: false });
  await realApp.register(jwtPlugin);
  await realApp.ready();

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
    presence: { getAvailableUsers: async () => ({}) },
  } as unknown as FastifyInstance;

  await widgetWsRoutes(fakeApp);
  if (!handler) throw new Error('handler not registered');
  return { handler, close: () => realApp.close() };
}

function multipartBody(
  fields: Record<string, string>,
  file: { filename: string; mimetype: string; buffer: Buffer },
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

const tick = () => new Promise((r) => setImmediate(r));

describe('webchat E2E (T-27)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the full visitor lifecycle: session -> send -> ws reply/resolve -> csat -> attachment', async () => {
    const { ingestWithHooks } = await import('../modules/channels/post-ingest');
    (ingestWithHooks as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: CONTACT_ID,
      conversationId: CONV_ID,
      messageId: 'm1',
      deduped: false,
      blocked: false,
    });

    // 1) /session — fresh visitor (no identity row) → server issues visitorId,
    // inserts the contact, and returns a widget session token.
    let visitorId: string;
    let sessionToken: string;
    const sessionApp = await buildChannelApp([[inboxRow()], []]);
    try {
      const res = await sessionApp.inject({
        method: 'POST',
        url: `/api/v1/widget/${INBOX_ID}/session`,
        payload: { widgetToken: WIDGET_TOKEN, identify: { name: 'Ana', email: 'ana@acme.com' } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.visitorId).toMatch(/^vis_[a-f0-9]{32,}$/);
      expect(body.contactId).toBe(CONTACT_ID);
      expect(body.sessionToken).toBeTruthy();
      visitorId = body.visitorId;
      sessionToken = body.sessionToken;
    } finally {
      await sessionApp.close();
    }

    // 2) /webhooks/webchat — the visitor (now registered) posts a message.
    const sendApp = await buildChannelApp([[inboxRow()], [{ id: 'identity-1' }]]);
    try {
      const res = await sendApp.inject({
        method: 'POST',
        url: `/webhooks/webchat/${INBOX_ID}`,
        payload: {
          widgetToken: WIDGET_TOKEN,
          visitorId,
          content: 'oi, preciso de ajuda',
          channelMsgId: 'cm-e2e-1',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().conversationId).toBe(CONV_ID);
      expect(ingestWithHooks).toHaveBeenCalledTimes(1);
    } finally {
      await sendApp.close();
    }

    // 3) /ws/widget — reusing the real session token (same JWT secret). The hello
    // surfaces the conversation, then an agent reply and a resolve are forwarded.
    const { handler, close } = await buildWsHandler([
      [{ id: CONV_ID, status: 'open' }],
      [{ name: 'Ana', email: 'ana@acme.com' }],
      [{ accountId: ACCOUNT_ID, config: { widgetToken: WIDGET_TOKEN } }],
      [],
    ]);
    try {
      const socket = new FakeSocket();
      await handler(socket, { url: `/ws/widget?token=${sessionToken}`, headers: { host: 'localhost' } });
      expect(socket.sent[0]?.type).toBe('hello');
      expect(socket.sent[0]?.conversationId).toBe(CONV_ID);

      eventBus.emitEvent({
        type: 'message.created',
        inboxId: INBOX_ID,
        conversationId: CONV_ID,
        message: { senderType: 'agent', senderId: 'agent-1', isPrivateNote: false } as never,
      } as RealtimeEvent);
      eventBus.emitEvent({
        type: 'conversation.resolved',
        inboxId: INBOX_ID,
        conversationId: CONV_ID,
      } as RealtimeEvent);
      await tick();
      socket.emit('close');

      expect(socket.sent.some((m) => m.type === 'message.created')).toBe(true);
      expect(socket.sent.some((m) => m.type === 'conversation.resolved')).toBe(true);
    } finally {
      await close();
    }

    // 4) /csat — the visitor rates the now-resolved conversation they own.
    const csatApp = await buildChannelApp([
      [inboxRow({ csat: { enabled: true } })],
      [{ contactId: CONTACT_ID }],
      [{ contactId: CONTACT_ID, inboxId: INBOX_ID, status: 'resolved' }],
    ]);
    try {
      const res = await csatApp.inject({
        method: 'POST',
        url: `/webhooks/webchat/${INBOX_ID}/csat`,
        payload: {
          widgetToken: WIDGET_TOKEN,
          visitorId,
          conversationId: CONV_ID,
          score: 5,
          comment: 'atendimento ótimo',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().id).toBeTruthy();
    } finally {
      await csatApp.close();
    }

    // 5) /attachment — the visitor uploads an image; it becomes a media message.
    const attachApp = await buildChannelApp([
      [inboxRow({ attachments: { enabled: true } })],
      [{ id: 'identity-1' }],
    ]);
    try {
      const res = await attachApp.inject({
        method: 'POST',
        url: `/webhooks/webchat/${INBOX_ID}/attachment`,
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
        payload: multipartBody(
          { widgetToken: WIDGET_TOKEN, visitorId },
          { filename: 'photo.png', mimetype: 'image/png', buffer: Buffer.alloc(2048, 1) },
        ),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().mediaUrl).toBe('https://r2.example/uploads/x.png');
      const arg = (ingestWithHooks as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as {
        mediaMimeType?: string;
        contentType?: string;
      };
      expect(arg.mediaMimeType).toBe('image/png');
      expect(arg.contentType).toBe('image');
    } finally {
      await attachApp.close();
    }
  });
});
