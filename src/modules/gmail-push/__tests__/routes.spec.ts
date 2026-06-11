/**
 * Tests do endpoint POST /api/v1/webhooks/gmail-push.
 *
 * Mocka o `verifyGoogleOidc` direto (não exercita JWT real). Foco está
 * em: 503 sem config, 401 com JWT inválido, 200 silent em bad envelope /
 * inbox not found, dedup via Redis SETNX, enqueue gmail-sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { gmailPushRoutes } from '../routes';
import * as oidc from '../../../lib/google-oidc-verify';

vi.mock('../../../config', () => ({
  config: {
    GMAIL_PUBSUB_AUDIENCE: 'https://axis-back.test/api/v1/webhooks/gmail-push',
    GCP_PROJECT_ID: 'test-project',
  },
}));

interface FakeQueue {
  add: ReturnType<typeof vi.fn>;
}

interface FakeRedis {
  set: ReturnType<typeof vi.fn>;
}

interface FakeApp {
  redis: FakeRedis;
  db: { select: ReturnType<typeof vi.fn> };
  queues: { getQueue: ReturnType<typeof vi.fn> };
}

function buildFakeInboxes(rows: Array<Record<string, unknown>>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
  };
}

async function buildApp(opts: {
  inboxes?: Array<Record<string, unknown>>;
  setnxResult?: 'OK' | null;
  oidcThrow?: oidc.OidcVerifyError;
}): Promise<{ app: FastifyInstance; fakeQueue: FakeQueue; redis: FakeRedis }> {
  const fakeQueue: FakeQueue = { add: vi.fn(async () => undefined) };
  // Nullish coalescing trataria `null` como vazio — usar ternary explicito.
  const setnxResult: 'OK' | null =
    'setnxResult' in opts ? (opts.setnxResult as 'OK' | null) : 'OK';
  const redis: FakeRedis = {
    set: vi.fn(async () => setnxResult),
  };
  const fake: FakeApp = {
    redis,
    db: buildFakeInboxes(opts.inboxes ?? []),
    queues: {
      getQueue: vi.fn(() => fakeQueue),
    },
  };

  if (opts.oidcThrow) {
    vi.spyOn(oidc, 'verifyGoogleOidc').mockRejectedValue(opts.oidcThrow);
  } else {
    vi.spyOn(oidc, 'verifyGoogleOidc').mockResolvedValue({
      email: 'gmail-push@test-project.iam.gserviceaccount.com',
      audience: 'https://axis-back.test/api/v1/webhooks/gmail-push',
      payload: {},
    });
  }

  const app = Fastify();
  await app.register(sensible);
  app.decorate('redis', fake.redis as never);
  app.decorate('db', fake.db as never);
  app.decorate('queues', fake.queues as never);
  await app.register(gmailPushRoutes);
  return { app, fakeQueue, redis };
}

const baseEnvelope = (overrides: Partial<{ data: unknown; messageId: string }> = {}) => ({
  message: {
    data:
      'data' in overrides
        ? (overrides.data as string)
        : Buffer.from(
            JSON.stringify({
              emailAddress: 'victoryuji182@gmail.com',
              historyId: '12345',
            }),
          ).toString('base64'),
    messageId: overrides.messageId ?? 'msg-1',
  },
  subscription: 'projects/test-project/subscriptions/gmail-push-sub',
});

describe('gmail-push endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('401 quando JWT é inválido', async () => {
    const { app } = await buildApp({
      oidcThrow: new oidc.OidcVerifyError('bad sig', 'invalid-signature'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/gmail-push',
      headers: { authorization: 'Bearer garbage' },
      payload: baseEnvelope(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('200 silent com bad envelope (Pub/Sub não re-entrega)', async () => {
    const { app } = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/gmail-push',
      headers: { authorization: 'Bearer ok' },
      payload: { not: 'an envelope' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: 'bad-envelope' });
  });

  it('200 dedup quando Redis SETNX devolve null (duplicate)', async () => {
    const { app, fakeQueue } = await buildApp({ setnxResult: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/gmail-push',
      headers: { authorization: 'Bearer ok' },
      payload: baseEnvelope(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, dedup: true });
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('200 silent quando nenhuma inbox bate com emailAddress', async () => {
    const { app, fakeQueue } = await buildApp({ inboxes: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/gmail-push',
      headers: { authorization: 'Bearer ok' },
      payload: baseEnvelope(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ignored: 'no-inbox' });
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('200 enfileira gmail-sync quando inbox bate', async () => {
    const inboxRow = {
      id: 'inbox-uuid-1',
      config: {
        provider: 'gmail',
        gmailEmail: 'victoryuji182@gmail.com',
      },
    };
    const { app, fakeQueue, redis } = await buildApp({ inboxes: [inboxRow] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/gmail-push',
      headers: { authorization: 'Bearer ok' },
      payload: baseEnvelope({ messageId: 'msg-42' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, enqueued: true });
    expect(fakeQueue.add).toHaveBeenCalledWith(
      'push-triggered',
      { inboxId: 'inbox-uuid-1' },
      expect.objectContaining({ priority: 1 }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'gmail-push:msg-42',
      '1',
      'EX',
      3600,
      'NX',
    );
  });

  it('ignora inbox com provider != gmail mesmo se gmailEmail bater', async () => {
    const inboxRow = {
      id: 'inbox-twilio',
      config: {
        provider: 'twilio',
        gmailEmail: 'victoryuji182@gmail.com',
      },
    };
    const { app, fakeQueue } = await buildApp({ inboxes: [inboxRow] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/gmail-push',
      headers: { authorization: 'Bearer ok' },
      payload: baseEnvelope(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ignored: 'no-inbox' });
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });
});
