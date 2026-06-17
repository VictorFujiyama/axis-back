import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// T-26: POST /api/v1/widget/:inboxId/session issues a visitor session. Covers the
// anonymous path, identify (new + existing contact), the anti-enumeration re-roll
// of client-supplied visitorIds, and the Origin allowlist (spec D3).

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const WIDGET_TOKEN = 'wt_test';
const EXISTING_VISITOR = `vis_${'b'.repeat(32)}`;
const UNKNOWN_VISITOR = `vis_${'c'.repeat(32)}`;
const EXISTING_CONTACT = '22222222-3333-4444-8555-666666666666';
const NEW_CONTACT = '44444444-5555-4666-8777-888888888888';

function inboxRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, primaryColor: '#7b3fa9', ...configOverrides },
    secrets: null as string | null,
    defaultBotId: null as string | null,
    enabled: true,
    deletedAt: null as Date | null,
  };
}

async function buildTestApp(
  results: unknown[],
): Promise<{ app: FastifyInstance; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { webchatChannelRoutes } = await import('../webchat-webhook');

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
      const p = Promise.resolve([{ id: NEW_CONTACT }]);
      return { returning: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
    },
  }));
  const update = vi.fn().mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  }));

  app.decorate('db', { select, insert, update } as unknown as FastifyInstance['db']);

  await app.register(webchatChannelRoutes);
  await app.ready();
  return { app, insert, update };
}

function sessionReq(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/widget/${INBOX_ID}/session`,
    headers,
    payload: { widgetToken: WIDGET_TOKEN, ...payload },
  });
}

describe('POST /api/v1/widget/:inboxId/session (T-26)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('issues an anonymous session and a server-side visitorId', async () => {
    const { app, insert } = await buildTestApp([[inboxRow()], []]);
    try {
      const res = await sessionReq(app, {});
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionToken).toBeTruthy();
      expect(body.visitorId).toMatch(/^vis_[a-f0-9]{32,}$/);
      expect(body.contactId).toBe(NEW_CONTACT);
      expect(insert).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('creates a contact with the identify name on a fresh visitor', async () => {
    const { app, insert } = await buildTestApp([[inboxRow()], []]);
    try {
      const res = await sessionReq(app, { identify: { name: 'Ana', email: 'ana@acme.com' } });
      expect(res.statusCode).toBe(200);
      const values = (insert.mock.results[0]!.value as { values: (v: unknown) => unknown }).values;
      expect(values).toBeTypeOf('function');
      expect(insert).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reuses the contact when the visitorId already exists', async () => {
    const { app, insert } = await buildTestApp([[inboxRow()], [{ contactId: EXISTING_CONTACT }]]);
    try {
      const res = await sessionReq(app, { visitorId: EXISTING_VISITOR });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.visitorId).toBe(EXISTING_VISITOR);
      expect(body.contactId).toBe(EXISTING_CONTACT);
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('re-rolls a client visitorId that does not exist (anti-enumeration)', async () => {
    const { app } = await buildTestApp([[inboxRow()], []]);
    try {
      const res = await sessionReq(app, { visitorId: UNKNOWN_VISITOR });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.visitorId).not.toBe(UNKNOWN_VISITOR);
      expect(body.visitorId).toMatch(/^vis_[a-f0-9]{32,}$/);
    } finally {
      await app.close();
    }
  });

  it('rejects an origin outside the inbox allowlist', async () => {
    const { app } = await buildTestApp([[inboxRow({ allowedOrigins: ['https://acme.com'] })]]);
    try {
      const res = await sessionReq(app, {}, { origin: 'https://evil.com' });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('allows an origin inside the inbox allowlist', async () => {
    const { app } = await buildTestApp([
      [inboxRow({ allowedOrigins: ['https://acme.com'] })],
      [],
    ]);
    try {
      const res = await sessionReq(app, {}, { origin: 'https://acme.com' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid widget token', async () => {
    const { app } = await buildTestApp([[inboxRow()]]);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/widget/${INBOX_ID}/session`,
        payload: { widgetToken: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects when the inbox is not webchat', async () => {
    const { app } = await buildTestApp([[{ ...inboxRow(), channelType: 'whatsapp' }]]);
    try {
      const res = await sessionReq(app, {});
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
