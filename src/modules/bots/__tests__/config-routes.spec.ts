import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@blossom/shared-types';

// Tasks 7+8 (playbook deprecation): endpoints REST de config do bot builtin.
// GET/PATCH /api/v1/bots/:botId/config, POST invalidate-cache, GET /versions e
// POST /rollback. DB mockado (convenção do repo pra route specs); o comportamento
// real do schema bots_config_versions é coberto pelo teste de integração da Task 1.

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const BOT_ID = '99999999-8888-4777-8666-555555555555';
const ATLAS_KEY = 'atlas-test-api-key';

// Antes de qualquer import dinâmico de ../config: o plugin atlas-auth congela
// config.ATLAS_API_KEY no primeiro import do módulo de config.
vi.stubEnv('ATLAS_API_KEY', ATLAS_KEY);

/** Awaitable query-builder chain: every builder method returns itself, and
 * awaiting it resolves `result`. */
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'for', 'innerJoin', 'leftJoin']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT_ID,
    accountId: TEST_ACCOUNT_ID,
    name: 'Marco',
    description: null,
    botType: 'builtin',
    webhookUrl: null,
    secret: 'enc',
    config: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      systemPrompt: 'Você é o Marco, SDR da Launch.',
      temperature: 0.7,
      maxTokens: 1024,
      playbookSource: 'inline',
      handoffKeywords: [],
      maxTurnsBeforeHandoff: null,
    },
    inboxId: '88888888-7777-4666-8555-444444444444',
    enabled: true,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function versionRow(version: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-00000000000${version}`,
    botId: BOT_ID,
    version,
    systemPrompt: `Prompt v${version}`,
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    temperature: '0.5',
    maxTokens: 900,
    etag: `e7a9${version}b2c4d6f8a0${version}c`.slice(0, 16),
    createdAt: new Date(`2026-07-0${version}T00:00:00.000Z`),
    createdByUserId: TEST_USER_ID,
    ...overrides,
  };
}

const versionInsertValues = vi.fn();
const botUpdateSet = vi.fn();
/** Chains created by app.db.select, in call order (pra inspecionar .limit etc). */
const dbSelectChains: Array<Record<string, unknown>> = [];

interface DbOptions {
  /** Bot row lookup ([] => 404). */
  botRow?: unknown[];
  /** Latest bots_config_versions row ([] => version 0). */
  latestVersion?: unknown[];
  /** Override completo da sequência de resultados de app.db.select. */
  selects?: unknown[][];
  /** Override completo da sequência de resultados de tx.select. */
  txSelects?: unknown[][];
}

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { default: atlasAuthPlugin } = await import('../../../plugins/atlas-auth');
  const { botConfigRoutes } = await import('../config-routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);
  await app.register(atlasAuthPlugin);

  // GET uses app.db.select twice (bot, latest version); invalidate-cache once.
  const selectResults = options.selects ?? [options.botRow ?? [botRow()], options.latestVersion ?? []];
  let selectCall = 0;
  const dbSelect = vi.fn().mockImplementation(() => {
    const c = chain(selectResults[selectCall++] ?? []);
    dbSelectChains.push(c);
    return c;
  });

  // PATCH runs inside a tx: bot FOR UPDATE, latest version, insert, update.
  // Rollback: bot FOR UPDATE, target version, latest version, insert, update.
  const txSelectResults =
    options.txSelects ?? [options.botRow ?? [botRow()], options.latestVersion ?? []];
  let txSelectCall = 0;
  const tx = {
    select: vi.fn().mockImplementation(() => chain(txSelectResults[txSelectCall++] ?? [])),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        versionInsertValues(vals);
        return chain(undefined);
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((vals: unknown) => {
        botUpdateSet(vals);
        return { where: vi.fn().mockReturnValue(chain(undefined)) };
      }),
    })),
  };

  // app.db.insert is used by writeAudit (fire-and-forget).
  const dbInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

  app.decorate('db', {
    select: dbSelect,
    insert: dbInsert,
    transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  } as unknown as FastifyInstance['db']);

  await app.register(botConfigRoutes);
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance, role: UserRole = 'admin'): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'admin@example.com',
    role,
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

async function currentEtag(): Promise<string> {
  const { configEtag } = await import('../config-routes');
  return configEtag(botRow().config as Parameters<typeof configEtag>[0]);
}

describe('GET /api/v1/bots/:botId/config', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('retorna config atual + etag + version', async () => {
    const app = await buildTestApp({ latestVersion: [{ version: 3 }] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json).toMatchObject({
        systemPrompt: 'Você é o Marco, SDR da Launch.',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        temperature: 0.7,
        maxTokens: 1024,
        version: 3,
      });
      expect(json.etag).toBe(await currentEtag());
      expect(json.etag).toHaveLength(16);
    } finally {
      await app.close();
    }
  });

  it('retorna 404 pra bot inexistente', async () => {
    const app = await buildTestApp({ botRow: [] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('retorna 400 pra bot externo (sem config LLM)', async () => {
    const app = await buildTestApp({ botRow: [botRow({ botType: 'external' })] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('aceita X-API-Key do Atlas no lugar do JWT admin', async () => {
    const app = await buildTestApp({ latestVersion: [{ version: 2 }] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { 'x-api-key': ATLAS_KEY },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('rejeita X-API-Key inválida com 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { 'x-api-key': 'nope' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /api/v1/bots/:botId/config', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('atualiza systemPrompt, bumpa version e insere row em bots_config_versions', async () => {
    const app = await buildTestApp({ latestVersion: [{ version: 4 }] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
        payload: { systemPrompt: 'Novo prompt do Marco, mais direto.' },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.version).toBe(5);
      expect(json.etag).toHaveLength(16);
      expect(json.etag).not.toBe(await currentEtag());
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: BOT_ID,
          version: 5,
          systemPrompt: 'Novo prompt do Marco, mais direto.',
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
          temperature: '0.7',
          maxTokens: 1024,
          etag: json.etag,
          createdByUserId: TEST_USER_ID,
        }),
      );
      expect(botUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemPrompt: 'Novo prompt do Marco, mais direto.',
            provider: 'anthropic',
            playbookSource: 'inline',
          }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('X-API-Key do Atlas: patcha e persiste version sem created_by_user_id', async () => {
    const app = await buildTestApp({ latestVersion: [{ version: 1 }] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { 'x-api-key': ATLAS_KEY },
        payload: { systemPrompt: 'Prompt editado pelo Atlas.' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe(2);
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'Prompt editado pelo Atlas.',
          createdByUserId: null,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('cria version 1 quando não há histórico', async () => {
    const app = await buildTestApp({ latestVersion: [] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
        payload: { temperature: 0.3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe(1);
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ version: 1, temperature: '0.3' }),
      );
    } finally {
      await app.close();
    }
  });

  it('retorna 409 quando expectedEtag não bate', async () => {
    const app = await buildTestApp({ latestVersion: [{ version: 4 }] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
        payload: { systemPrompt: 'Prompt novo.', expectedEtag: 'deadbeefdeadbeef' },
      });
      expect(res.statusCode).toBe(409);
      expect(versionInsertValues).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('aceita expectedEtag correto', async () => {
    const app = await buildTestApp({ latestVersion: [{ version: 4 }] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
        payload: { systemPrompt: 'Prompt novo.', expectedEtag: await currentEtag() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe(5);
    } finally {
      await app.close();
    }
  });

  it('retorna 404 pra bot fora da conta', async () => {
    const app = await buildTestApp({ botRow: [] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
        payload: { systemPrompt: 'Prompt novo.' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejeita body sem nenhum campo de config com 400', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app) },
        payload: { expectedEtag: 'deadbeefdeadbeef' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('exige role admin', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/bots/${BOT_ID}/config`,
        headers: { authorization: authHeader(app, 'agent') },
        payload: { systemPrompt: 'Prompt novo.' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/v1/bots/:botId/invalidate-cache', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('retorna 200 no-op', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/invalidate-cache`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('retorna 404 pra bot fora da conta', async () => {
    const app = await buildTestApp({ botRow: [] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/invalidate-cache`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/v1/bots/:botId/versions', () => {
  afterEach(() => {
    vi.clearAllMocks();
    dbSelectChains.length = 0;
  });

  it('retorna lista desc com etagPrefix de 8 chars', async () => {
    const app = await buildTestApp({
      selects: [[botRow()], [versionRow(3), versionRow(2), versionRow(1)]],
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/versions`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
      expect(json[0]).toEqual({
        version: 3,
        createdAt: versionRow(3).createdAt.toISOString(),
        createdByUserId: TEST_USER_ID,
        etagPrefix: (versionRow(3).etag as string).slice(0, 8),
      });
      expect(json[0].etagPrefix).toHaveLength(8);
    } finally {
      await app.close();
    }
  });

  it('aplica ?limit=N na query (default 20)', async () => {
    const app = await buildTestApp({ selects: [[botRow()], [], [botRow()], []] });
    try {
      const res1 = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/versions?limit=5`,
        headers: { authorization: authHeader(app) },
      });
      expect(res1.statusCode).toBe(200);
      expect(dbSelectChains[1]?.limit).toHaveBeenCalledWith(5);

      const res2 = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/versions`,
        headers: { authorization: authHeader(app) },
      });
      expect(res2.statusCode).toBe(200);
      expect(dbSelectChains[3]?.limit).toHaveBeenCalledWith(20);
    } finally {
      await app.close();
    }
  });

  it('retorna 404 pra bot fora da conta', async () => {
    const app = await buildTestApp({ selects: [[]] });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${BOT_ID}/versions`,
        headers: { authorization: authHeader(app) },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/v1/bots/:botId/rollback', () => {
  afterEach(() => {
    vi.clearAllMocks();
    dbSelectChains.length = 0;
  });

  it('restaura config da versão alvo e cria versão nova (não deleta histórico)', async () => {
    const app = await buildTestApp({
      txSelects: [[botRow()], [versionRow(2)], [{ version: 5 }]],
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/rollback`,
        headers: { authorization: authHeader(app) },
        payload: { targetVersion: 2 },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.version).toBe(6);
      const { configEtag } = await import('../config-routes');
      expect(json.etag).toBe(
        configEtag({
          systemPrompt: 'Prompt v2',
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
          temperature: 0.5,
          maxTokens: 900,
        }),
      );
      expect(versionInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: BOT_ID,
          version: 6,
          systemPrompt: 'Prompt v2',
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
          temperature: '0.5',
          maxTokens: 900,
          etag: json.etag,
          createdByUserId: TEST_USER_ID,
        }),
      );
      expect(botUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemPrompt: 'Prompt v2',
            temperature: 0.5,
            maxTokens: 900,
            // Campos fora do histórico permanecem os atuais do bot.
            playbookSource: 'inline',
            handoffKeywords: [],
          }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('retorna 404 quando targetVersion não existe', async () => {
    const app = await buildTestApp({ txSelects: [[botRow()], []] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/rollback`,
        headers: { authorization: authHeader(app) },
        payload: { targetVersion: 42 },
      });
      expect(res.statusCode).toBe(404);
      expect(versionInsertValues).not.toHaveBeenCalled();
      expect(botUpdateSet).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('retorna 409 quando expectedEtag não bate', async () => {
    const app = await buildTestApp({ txSelects: [[botRow()]] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/rollback`,
        headers: { authorization: authHeader(app) },
        payload: { targetVersion: 2, expectedEtag: 'deadbeefdeadbeef' },
      });
      expect(res.statusCode).toBe(409);
      expect(versionInsertValues).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('retorna 404 pra bot fora da conta', async () => {
    const app = await buildTestApp({ txSelects: [[]] });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/rollback`,
        headers: { authorization: authHeader(app) },
        payload: { targetVersion: 2 },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejeita body sem targetVersion com 400', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/bots/${BOT_ID}/rollback`,
        headers: { authorization: authHeader(app) },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
