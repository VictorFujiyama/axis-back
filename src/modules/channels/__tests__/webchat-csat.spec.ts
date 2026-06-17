import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-18: POST /webhooks/webchat/:inboxId/csat records a visitor rating. Auth is
// widgetToken + visitorId; the rating is only accepted for a resolved
// conversation the visitor owns, and only when csat is enabled on the inbox.

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const WIDGET_TOKEN = 'wt_test';
const VISITOR_ID = `vis_${'a'.repeat(32)}`;
const CONTACT_ID = '22222222-3333-4444-8555-666666666666';
const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';

function inboxRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, csat: { enabled: true }, ...configOverrides },
    secrets: null as string | null,
    defaultBotId: null as string | null,
    enabled: true,
    deletedAt: null as Date | null,
  };
}

async function buildTestApp(results: unknown[]): Promise<{ app: FastifyInstance; insert: ReturnType<typeof vi.fn> }> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { webchatChannelRoutes } = await import('../webchat-webhook');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  // select() resolves from a queue keyed by call index: inbox, contactIdentities,
  // conversation (only the calls the route actually reaches).
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
    values: () => ({ returning: () => Promise.resolve([{ id: 'csat-row-1' }]) }),
  }));

  app.decorate('db', { select, insert } as unknown as FastifyInstance['db']);

  await app.register(webchatChannelRoutes);
  await app.ready();
  return { app, insert };
}

function csatReq(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/webchat/${INBOX_ID}/csat`,
    payload: { widgetToken: WIDGET_TOKEN, visitorId: VISITOR_ID, conversationId: CONVERSATION_ID, ...payload },
  });
}

describe('POST /webhooks/webchat/:inboxId/csat (T-18)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records a rating for a resolved conversation the visitor owns', async () => {
    const { app, insert } = await buildTestApp([
      [inboxRow()],
      [{ contactId: CONTACT_ID }],
      [{ contactId: CONTACT_ID, inboxId: INBOX_ID, status: 'resolved' }],
    ]);
    try {
      const res = await csatReq(app, { score: 5, comment: 'ótimo' });
      expect(res.statusCode).toBe(201);
      expect(insert).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects when the conversation is not resolved', async () => {
    const { app, insert } = await buildTestApp([
      [inboxRow()],
      [{ contactId: CONTACT_ID }],
      [{ contactId: CONTACT_ID, inboxId: INBOX_ID, status: 'open' }],
    ]);
    try {
      const res = await csatReq(app, { score: 4 });
      expect(res.statusCode).toBe(409);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects when the conversation belongs to another contact', async () => {
    const { app, insert } = await buildTestApp([
      [inboxRow()],
      [{ contactId: CONTACT_ID }],
      [{ contactId: 'someone-else', inboxId: INBOX_ID, status: 'resolved' }],
    ]);
    try {
      const res = await csatReq(app, { score: 4 });
      expect(res.statusCode).toBe(404);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects when csat is disabled on the inbox', async () => {
    const { app, insert } = await buildTestApp([[inboxRow({ csat: { enabled: false } })]]);
    try {
      const res = await csatReq(app, { score: 5 });
      expect(res.statusCode).toBe(403);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an unregistered visitor', async () => {
    const { app, insert } = await buildTestApp([[inboxRow()], []]);
    try {
      const res = await csatReq(app, { score: 5 });
      expect(res.statusCode).toBe(401);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a score outside 1-5', async () => {
    const { app, insert } = await buildTestApp([[inboxRow()]]);
    try {
      const res = await csatReq(app, { score: 9 });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
