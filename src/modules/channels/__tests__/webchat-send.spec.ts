import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-26: POST /webhooks/webchat/:inboxId ingests an inbound visitor message. Auth is
// widgetToken + a registered visitorId. Covers dedup (200), bot-block (200), the
// unregistered-visitor guard, and the per-(inbox,visitor) rate limit.

vi.mock('../post-ingest', () => ({
  ingestWithHooks: vi.fn(async () => ({
    contactId: 'c1',
    conversationId: 'conv1',
    messageId: 'm1',
    deduped: false,
    blocked: false,
  })),
}));

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const WIDGET_TOKEN = 'wt_test';
const VISITOR_ID = `vis_${'a'.repeat(32)}`;

function inboxRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, ...configOverrides },
    secrets: null as string | null,
    defaultBotId: null as string | null,
    enabled: true,
    deletedAt: null as Date | null,
  };
}

// select() is called twice per request: inbox lookup, then the contactIdentity
// guard. `mode: 'alternate'` makes the mock return inbox/identity by call parity
// so the rate-limit test can fire many requests without exhausting a fixed queue.
async function buildTestApp(
  opts: { results?: unknown[]; alternate?: boolean; rateLimit?: boolean } = {},
): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { webchatChannelRoutes } = await import('../webchat-webhook');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);
  if (opts.rateLimit) {
    const rateLimit = (await import('@fastify/rate-limit')).default;
    await app.register(rateLimit, { global: false });
  }

  const results = opts.results ?? [];
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const idx = call++;
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.innerJoin = () => q;
    q.limit = () => {
      if (opts.alternate) {
        return Promise.resolve(idx % 2 === 0 ? [inboxRow()] : [{ id: 'identity-1' }]);
      }
      return Promise.resolve(results[idx] ?? []);
    };
    return q;
  });

  app.decorate('db', { select } as unknown as FastifyInstance['db']);

  await app.register(webchatChannelRoutes);
  await app.ready();
  return app;
}

function sendReq(app: FastifyInstance, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/webchat/${INBOX_ID}`,
    payload: {
      widgetToken: WIDGET_TOKEN,
      visitorId: VISITOR_ID,
      content: 'oi',
      channelMsgId: 'cm-1',
      ...payload,
    },
  });
}

describe('POST /webhooks/webchat/:inboxId (T-26)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ingests a message as a registered visitor', async () => {
    const app = await buildTestApp({ results: [[inboxRow()], [{ id: 'identity-1' }]] });
    const { ingestWithHooks } = await import('../post-ingest');
    try {
      const res = await sendReq(app, { channelMsgId: 'cm-new' });
      expect(res.statusCode).toBe(201);
      expect(ingestWithHooks).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns 200 on a deduped message', async () => {
    const app = await buildTestApp({ results: [[inboxRow()], [{ id: 'identity-1' }]] });
    const { ingestWithHooks } = await import('../post-ingest');
    (ingestWithHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      contactId: 'c1',
      conversationId: 'conv1',
      messageId: 'm1',
      deduped: true,
      blocked: false,
    });
    try {
      const res = await sendReq(app);
      expect(res.statusCode).toBe(200);
      expect(res.json().deduped).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 200 accepted:false when the message is blocked', async () => {
    const app = await buildTestApp({ results: [[inboxRow()], [{ id: 'identity-1' }]] });
    const { ingestWithHooks } = await import('../post-ingest');
    (ingestWithHooks as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocked: true,
    });
    try {
      const res = await sendReq(app);
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects an unregistered visitor without ingesting', async () => {
    const app = await buildTestApp({ results: [[inboxRow()], []] });
    const { ingestWithHooks } = await import('../post-ingest');
    try {
      const res = await sendReq(app);
      expect(res.statusCode).toBe(401);
      expect(ingestWithHooks).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid widget token', async () => {
    const app = await buildTestApp({ results: [[inboxRow()]] });
    try {
      const res = await sendReq(app, { widgetToken: 'wrong' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed visitorId without ingesting', async () => {
    const app = await buildTestApp({ results: [[inboxRow()]] });
    const { ingestWithHooks } = await import('../post-ingest');
    try {
      const res = await sendReq(app, { visitorId: 'nope' });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(ingestWithHooks).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rate-limits a flood from the same visitor (max 30/min)', async () => {
    const app = await buildTestApp({ alternate: true, rateLimit: true });
    try {
      let limited = false;
      for (let i = 0; i < 32; i++) {
        const res = await sendReq(app, { channelMsgId: `cm-${i}` });
        if (res.statusCode === 429) {
          limited = true;
          break;
        }
      }
      expect(limited).toBe(true);
    } finally {
      await app.close();
    }
  });
});
