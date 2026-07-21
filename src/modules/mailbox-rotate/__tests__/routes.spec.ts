import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Fase 5.1 — rota /api/v1/internal/mailbox-rotate.
// Redis + DB mockados; a lógica de reserva atômica (RESERVE_SLOT_LUA) é coberta
// pelo teste de integração de inbox-cap-script.

const ATLAS_KEY = 'atlas-test-api-key';
vi.stubEnv('ATLAS_API_KEY', ATLAS_KEY);

const MB_1 = '11111111-1111-4111-8111-111111111111';
const MB_2 = '22222222-2222-4222-8222-222222222222';
const MB_3 = '33333333-3333-4333-8333-333333333333';

function inboxRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `inbox-${id.slice(0, 4)}`,
    channelType: 'email',
    enabled: true,
    deletedAt: null,
    config: {
      provider: 'gmail',
      gmailEmail: `test-${id.slice(0, 4)}@gmail.com`,
      dailySendCap: 30,
      timezone: 'America/Sao_Paulo',
    },
    ...overrides,
  };
}

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

interface RedisMock {
  counters: Record<string, number>;
  paused: Set<string>;
  reserveOutcomes: Array<'ok' | 'over-cap' | 'paused' | 'reserved-already'>;
  evalCalls: number;
}

interface BuildOpts {
  rows: unknown[];
  redis?: Partial<RedisMock>;
}

async function buildTestApp(opts: BuildOpts): Promise<{ app: FastifyInstance; redis: RedisMock }> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth');
  const { mailboxRotateRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(atlasAuthPlugin);

  const dbSelect = vi.fn().mockImplementation(() => chain(opts.rows));
  app.decorate('db', {
    select: dbSelect,
  } as unknown as FastifyInstance['db']);

  const redisMock: RedisMock = {
    counters: opts.redis?.counters ?? {},
    paused: opts.redis?.paused ?? new Set(),
    reserveOutcomes: opts.redis?.reserveOutcomes ?? [],
    evalCalls: 0,
  };
  const fakeRedis = {
    get: vi.fn(async (key: string) => {
      // isInboxPaused key: inbox:<id>:paused
      if (key.endsWith(':paused')) {
        const id = key.split(':')[1];
        return redisMock.paused.has(id!) ? '1' : null;
      }
      // currentSendCount key: inbox:<id>:sent:<yyyy-mm-dd>-<tz>
      if (key.includes(':sent:')) {
        const id = key.split(':')[1];
        const v = redisMock.counters[id!];
        return v != null ? String(v) : null;
      }
      return null;
    }),
    eval: vi.fn(async () => {
      const outcome = redisMock.reserveOutcomes[redisMock.evalCalls++] ?? 'ok';
      return outcome;
    }),
  };
  app.decorate('redis', fakeRedis as unknown as FastifyInstance['redis']);

  await app.register(mailboxRotateRoutes);
  await app.ready();
  return { app, redis: redisMock };
}

describe('POST /api/v1/internal/mailbox-rotate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejeita sem X-API-Key com 401', async () => {
    const { app } = await buildTestApp({ rows: [inboxRow(MB_1)] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        payload: { mailboxIds: [MB_1], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rejeita body inválido com 400 (mailboxIds vazio)', async () => {
    const { app } = await buildTestApp({ rows: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('retorna selectedMailboxId + remainingCap quando 1 mailbox disponível', async () => {
    const { app, redis } = await buildTestApp({
      rows: [inboxRow(MB_1)],
      redis: { counters: { [MB_1]: 5 }, reserveOutcomes: ['ok'] },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.selectedMailboxId).toBe(MB_1);
      expect(json.remainingCap).toBeGreaterThanOrEqual(0);
      expect(redis.evalCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('escolhe a menos carregada entre 2 mailboxes', async () => {
    // MB_1: 25/30 (17% remaining), MB_2: 3/30 (90% remaining) → MB_2 vence
    const { app } = await buildTestApp({
      rows: [inboxRow(MB_1), inboxRow(MB_2)],
      redis: { counters: { [MB_1]: 25, [MB_2]: 3 }, reserveOutcomes: ['ok'] },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedMailboxId).toBe(MB_2);
    } finally {
      await app.close();
    }
  });

  it('retorna delayed + resumeAt quando todas capadas', async () => {
    const { app } = await buildTestApp({
      rows: [inboxRow(MB_1), inboxRow(MB_2)],
      redis: { counters: { [MB_1]: 30, [MB_2]: 30 } },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.delayed).toBe(true);
      expect(json.resumeAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      await app.close();
    }
  });

  it('pula mailbox pausada e escolhe a próxima', async () => {
    const { app } = await buildTestApp({
      rows: [inboxRow(MB_1), inboxRow(MB_2)],
      redis: {
        counters: { [MB_1]: 3, [MB_2]: 10 },
        paused: new Set([MB_1]),
        reserveOutcomes: ['ok'],
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedMailboxId).toBe(MB_2);
    } finally {
      await app.close();
    }
  });

  it('pula inbox não-gmail (rotação só faz sentido em canal com cap por reputação)', async () => {
    const { app } = await buildTestApp({
      rows: [
        inboxRow(MB_1, {
          config: {
            provider: 'imap',
            imapHost: 'mail.example.com',
            timezone: 'America/Sao_Paulo',
          },
        }),
        inboxRow(MB_2),
      ],
      redis: { counters: { [MB_2]: 3 }, reserveOutcomes: ['ok'] },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedMailboxId).toBe(MB_2);
    } finally {
      await app.close();
    }
  });

  it('tenta próxima candidata em race (reserve retorna over-cap)', async () => {
    // Duas ok localmente, mas a 1ª tentativa perde a race → 2ª ok
    const { app, redis } = await buildTestApp({
      rows: [inboxRow(MB_1), inboxRow(MB_2)],
      redis: {
        counters: { [MB_1]: 3, [MB_2]: 10 },
        reserveOutcomes: ['over-cap', 'ok'], // 1ª tenta MB_1 (menos carregada), perde. 2ª tenta MB_2.
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedMailboxId).toBe(MB_2);
      expect(redis.evalCalls).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('dailyCapOverride do node sobrescreve dailySendCap da inbox', async () => {
    // Cap inbox = 30, override = 5 → sent=6 já está over-cap
    const { app } = await buildTestApp({
      rows: [inboxRow(MB_1)],
      redis: { counters: { [MB_1]: 6 } },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1], messageId: 'msg-1', dailyCapOverride: 5 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().delayed).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('reserved-already é idempotente: retorna mesma mailbox sem incrementar', async () => {
    const { app } = await buildTestApp({
      rows: [inboxRow(MB_1), inboxRow(MB_2)],
      redis: {
        counters: { [MB_1]: 3, [MB_2]: 10 },
        reserveOutcomes: ['reserved-already'],
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedMailboxId).toBe(MB_1);
    } finally {
      await app.close();
    }
  });

  it('ignora inbox soft-deleted ou disabled via WHERE clause do DB (não retorna row)', async () => {
    // Simulamos filtro no DB: só MB_3 retornado
    const { app } = await buildTestApp({
      rows: [inboxRow(MB_3)],
      redis: { counters: { [MB_3]: 0 }, reserveOutcomes: ['ok'] },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/mailbox-rotate',
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { mailboxIds: [MB_1, MB_2, MB_3], messageId: 'msg-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().selectedMailboxId).toBe(MB_3);
    } finally {
      await app.close();
    }
  });
});
