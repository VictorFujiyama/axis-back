import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { encryptJSON } from '../../../crypto';

// T-11: POST /api/v1/widget/:inboxId/session validates an identifier hash when
// the inbox has hmac enabled. mandatory=true rejects identify without a valid
// hash (401); without hmac the identify proceeds as before.

const INBOX_ID = '99999999-8888-4777-8666-555555555555';
const WIDGET_TOKEN = 'wt_test';
const HMAC_TOKEN = 'a'.repeat(64);
const IDENTIFIER = 'user-42';
const VALID_HASH = createHmac('sha256', HMAC_TOKEN).update(IDENTIFIER).digest('hex');

function inboxRow(configOverrides: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    name: 'Site Demo',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, primaryColor: '#7b3fa9', ...configOverrides },
    secrets: encryptJSON({ hmacToken: HMAC_TOKEN }) as string | null,
    defaultBotId: null as string | null,
    enabled: true,
    deletedAt: null as Date | null,
  };
}

const EXISTING_IDENTITY = { contactId: '22222222-3333-4444-8555-666666666666' };

interface DbOptions {
  inbox?: unknown[];
  /** When set, the second select (contactIdentities) returns this. */
  identity?: unknown[];
}

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { webchatChannelRoutes } = await import('../webchat-webhook');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  // select() is called in order: inbox lookup (.limit), then contactIdentities
  // (.limit). Resolve each from a queue keyed by call index.
  const results = [options.inbox ?? [inboxRow()], options.identity ?? [EXISTING_IDENTITY]];
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const idx = call++;
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.innerJoin = () => q;
    q.limit = () => Promise.resolve(results[idx] ?? []);
    q.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(results[idx] ?? []).then(onF, onR);
    return q;
  });

  app.decorate('db', { select } as unknown as FastifyInstance['db']);

  await app.register(webchatChannelRoutes);
  await app.ready();
  return app;
}

function sessionReq(app: FastifyInstance, identify: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/widget/${INBOX_ID}/session`,
    payload: { widgetToken: WIDGET_TOKEN, identify },
  });
}

describe('POST /api/v1/widget/:inboxId/session — hmac (T-11)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a valid identifier hash when hmac is enabled', async () => {
    const app = await buildTestApp({
      inbox: [inboxRow({ hmac: { enabled: true, mandatory: true } })],
    });
    try {
      const res = await sessionReq(app, { identifier: IDENTIFIER, identifierHash: VALID_HASH });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessionToken).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid hash when mandatory', async () => {
    const app = await buildTestApp({
      inbox: [inboxRow({ hmac: { enabled: true, mandatory: true } })],
    });
    try {
      const res = await sessionReq(app, { identifier: IDENTIFIER, identifierHash: 'deadbeef' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejects a missing hash when mandatory', async () => {
    const app = await buildTestApp({
      inbox: [inboxRow({ hmac: { enabled: true, mandatory: true } })],
    });
    try {
      const res = await sessionReq(app, { name: 'Ana' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('allows an invalid hash when not mandatory (anonymous)', async () => {
    const app = await buildTestApp({
      inbox: [inboxRow({ hmac: { enabled: true, mandatory: false } })],
    });
    try {
      const res = await sessionReq(app, { identifier: IDENTIFIER, identifierHash: 'deadbeef' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('ignores the hash entirely when hmac is disabled', async () => {
    const app = await buildTestApp();
    try {
      const res = await sessionReq(app, { identifier: IDENTIFIER, identifierHash: 'deadbeef' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
