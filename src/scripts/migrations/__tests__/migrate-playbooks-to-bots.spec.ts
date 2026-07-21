import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type DB } from '@blossom/db';
import { configEtag } from '../../../modules/bots/config-routes';
import { migratePlaybooksToBots, type DbOrTx } from '../migrate-playbooks-to-bots';

// Task 9 (playbook deprecation): one-shot idempotente inbox_playbooks →
// bots.config. Integração contra Postgres real com o schema aplicado —
// aponte MIGRATE_TEST_DATABASE_URL pro banco local (docker :5434):
//   MIGRATE_TEST_DATABASE_URL=postgresql://blossom:blossom_dev@localhost:5434/blossom \
//     pnpm vitest run src/scripts/migrations/__tests__/migrate-playbooks-to-bots.spec.ts
// Cada teste roda dentro de uma transação com rollback — nada persiste.

const DB_URL = process.env.MIGRATE_TEST_DATABASE_URL ?? process.env.SEED_TEST_DATABASE_URL;

const PLAYBOOK_CONTENT = 'Você é o Marco, SDR da Launch. Ofereça 3 horários.';

describe.skipIf(!DB_URL)('migratePlaybooksToBots (integration)', () => {
  let db: DB;
  let client: ReturnType<typeof createDb>['client'];

  beforeAll(() => {
    ({ db, client } = createDb(DB_URL!));
  });

  afterAll(async () => {
    await client.end();
  });

  class Rollback extends Error {}

  async function withRollback(fn: (tx: DbOrTx) => Promise<void>): Promise<void> {
    await db
      .transaction(async (tx) => {
        // O banco de dev pode ter bots reais que poluiriam as stats. Delete
        // dentro da tx (rollback desfaz) pra cada teste partir de estado limpo.
        await tx.delete(schema.bots);
        await fn(tx);
        throw new Rollback('rollback');
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  function baseConfig(overrides: Record<string, unknown> = {}) {
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      systemPrompt: 'placeholder inline',
      temperature: 0.7,
      maxTokens: 1024,
      playbookSource: 'local',
      handoffKeywords: [],
      maxTurnsBeforeHandoff: null,
      ...overrides,
    };
  }

  async function createBot(
    tx: DbOrTx,
    opts: { config?: Record<string, unknown>; playbookContent?: string | null } = {},
  ): Promise<{ botId: string; inboxId: string }> {
    const [account] = await tx
      .insert(schema.accounts)
      .values({ name: `mig-test-${crypto.randomUUID().slice(0, 8)}` })
      .returning();
    const [inbox] = await tx
      .insert(schema.inboxes)
      .values({
        accountId: account!.id,
        name: `mig-test-inbox-${crypto.randomUUID().slice(0, 8)}`,
        channelType: 'api',
        config: {},
      })
      .returning();
    const [bot] = await tx
      .insert(schema.bots)
      .values({
        accountId: account!.id,
        inboxId: inbox!.id,
        name: 'Marco',
        botType: 'builtin',
        secret: 'enc-test',
        config: opts.config ?? baseConfig(),
      })
      .returning();
    if (opts.playbookContent != null) {
      await tx.insert(schema.inboxPlaybooks).values({
        inboxId: inbox!.id,
        content: opts.playbookContent,
        etag: 'abcd1234abcd1234',
      });
    }
    return { botId: bot!.id, inboxId: inbox!.id };
  }

  async function fetchBotConfig(tx: DbOrTx, botId: string): Promise<Record<string, unknown>> {
    const [bot] = await tx
      .select({ config: schema.bots.config })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId))
      .limit(1);
    return bot!.config as Record<string, unknown>;
  }

  async function fetchVersions(tx: DbOrTx, botId: string) {
    return tx
      .select()
      .from(schema.botsConfigVersions)
      .where(eq(schema.botsConfigVersions.botId, botId));
  }

  it("primeiro run migra bot com playbookSource='local'", async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, { playbookContent: PLAYBOOK_CONTENT });

      const stats = await migratePlaybooksToBots(tx);
      expect(stats.migrated).toBe(1);
      expect(stats.manual).toBe(0);

      const cfg = await fetchBotConfig(tx, botId);
      expect(cfg.systemPrompt).toBe(PLAYBOOK_CONTENT);
      expect(cfg.playbookSource).toBe('inline');
    });
  });

  it('preserva chaves extras do config (jsonb_set, não replace)', async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, {
        config: baseConfig({ customQuirk: 'mantenha-me' }),
        playbookContent: PLAYBOOK_CONTENT,
      });

      await migratePlaybooksToBots(tx);

      const cfg = await fetchBotConfig(tx, botId);
      expect(cfg.customQuirk).toBe('mantenha-me');
      expect(cfg.greetingMessage).toBeUndefined();
    });
  });

  it('segundo run é no-op — zero mutações (idempotência)', async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, { playbookContent: PLAYBOOK_CONTENT });

      const first = await migratePlaybooksToBots(tx);
      expect(first.migrated).toBe(1);

      const cfgAfterFirst = await fetchBotConfig(tx, botId);
      const versionsAfterFirst = await fetchVersions(tx, botId);
      const [{ updatedAt: updatedAtAfterFirst }] = await tx
        .select({ updatedAt: schema.bots.updatedAt })
        .from(schema.bots)
        .where(eq(schema.bots.id, botId))
        .limit(1);

      const second = await migratePlaybooksToBots(tx);
      expect(second.migrated).toBe(0);
      expect(second.noop).toBe(1);
      expect(second.manual).toBe(0);

      const cfgAfterSecond = await fetchBotConfig(tx, botId);
      const versionsAfterSecond = await fetchVersions(tx, botId);
      const [{ updatedAt: updatedAtAfterSecond }] = await tx
        .select({ updatedAt: schema.bots.updatedAt })
        .from(schema.bots)
        .where(eq(schema.bots.id, botId))
        .limit(1);

      expect(cfgAfterSecond).toEqual(cfgAfterFirst);
      expect(versionsAfterSecond).toEqual(versionsAfterFirst);
      expect(updatedAtAfterSecond).toEqual(updatedAtAfterFirst);
    });
  });

  it("bot com playbookSource='atlas' → manual, config intocada", async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, {
        config: baseConfig({ playbookSource: 'atlas' }),
        playbookContent: PLAYBOOK_CONTENT,
      });

      const stats = await migratePlaybooksToBots(tx);
      expect(stats.manual).toBe(1);
      expect(stats.migrated).toBe(0);

      const cfg = await fetchBotConfig(tx, botId);
      expect(cfg.playbookSource).toBe('atlas');
      expect(cfg.systemPrompt).toBe('placeholder inline');
      expect(await fetchVersions(tx, botId)).toHaveLength(0);
    });
  });

  it("bot 'local' sem playbook → noop, config intocada", async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, { playbookContent: null });

      const stats = await migratePlaybooksToBots(tx);
      expect(stats.noop).toBe(1);
      expect(stats.migrated).toBe(0);
      expect(stats.manual).toBe(0);

      const cfg = await fetchBotConfig(tx, botId);
      expect(cfg.playbookSource).toBe('local');
      expect(cfg.systemPrompt).toBe('placeholder inline');
      expect(await fetchVersions(tx, botId)).toHaveLength(0);
    });
  });

  it("bot com playbookSource='inline' → noop imediato", async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, {
        config: baseConfig({ playbookSource: 'inline' }),
        playbookContent: PLAYBOOK_CONTENT,
      });

      const stats = await migratePlaybooksToBots(tx);
      expect(stats.noop).toBe(1);
      expect(stats.migrated).toBe(0);
      expect(await fetchVersions(tx, botId)).toHaveLength(0);
    });
  });

  it('insere row v1 em bots_config_versions com etag do config migrado', async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, { playbookContent: PLAYBOOK_CONTENT });

      await migratePlaybooksToBots(tx);

      const versions = await fetchVersions(tx, botId);
      expect(versions).toHaveLength(1);
      const v1 = versions[0]!;
      expect(v1.version).toBe(1);
      expect(v1.systemPrompt).toBe(PLAYBOOK_CONTENT);
      expect(v1.model).toBe('claude-sonnet-4-5');
      expect(v1.provider).toBe('anthropic');
      expect(v1.temperature).toBe('0.7');
      expect(v1.maxTokens).toBe(1024);
      expect(v1.createdByUserId).toBeNull();
      expect(v1.etag).toBe(
        configEtag({
          systemPrompt: PLAYBOOK_CONTENT,
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
          temperature: 0.7,
          maxTokens: 1024,
        }),
      );
    });
  });

  it('bot que já tem versões (Tasks 7/8) recebe a próxima versão, não v1', async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, { playbookContent: PLAYBOOK_CONTENT });
      await tx.insert(schema.botsConfigVersions).values({
        botId,
        version: 3,
        systemPrompt: 'prompt antigo v3',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        temperature: '0.7',
        maxTokens: 1024,
        etag: '1111222233334444',
      });

      const stats = await migratePlaybooksToBots(tx);
      expect(stats.migrated).toBe(1);

      const versions = await fetchVersions(tx, botId);
      expect(versions.map((v) => v.version).sort()).toEqual([3, 4]);
      const v4 = versions.find((v) => v.version === 4)!;
      expect(v4.systemPrompt).toBe(PLAYBOOK_CONTENT);
    });
  });

  it('playbook maior que o limite do schema (10k) → manual, nada gravado', async () => {
    await withRollback(async (tx) => {
      const { botId } = await createBot(tx, { playbookContent: 'x'.repeat(10_001) });

      const stats = await migratePlaybooksToBots(tx);
      expect(stats.manual).toBe(1);
      expect(stats.migrated).toBe(0);

      const cfg = await fetchBotConfig(tx, botId);
      expect(cfg.playbookSource).toBe('local');
      expect(await fetchVersions(tx, botId)).toHaveLength(0);
    });
  });
});
