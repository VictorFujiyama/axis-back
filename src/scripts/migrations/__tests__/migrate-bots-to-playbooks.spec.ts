import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, schema, type DB } from '@blossom/db';
import { migrateBotsToPlaybooks } from '../migrate-bots-to-playbooks';

// Integration test — real local Postgres (blossom-postgres, :5434). The LIVE
// runs are scoped to the seeded account via `accountId`, so nothing else in
// the dev DB is touched. Skips itself when the DB is unreachable.
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://blossom:blossom_dev@localhost:5434/blossom';

async function probe(): Promise<boolean> {
  const sql = postgres(DB_URL, { max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

const dbUp = await probe();

const PROMPT = 'Você é o Yuji, assistente de vendas. Seja amigável e objetivo.';

describe.skipIf(!dbUp)('migrate-bots-to-playbooks', () => {
  let db: DB;
  let client: postgres.Sql;
  let accountId: string;
  let inboxA: string; // bot with systemPrompt → candidate
  let inboxB: string; // bot with empty config → not a candidate
  let inboxC: string; // bot already migrated → not a candidate
  let botA: string;

  beforeAll(async () => {
    ({ db, client } = createDb(DB_URL));
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: 'migrate-bots-spec' })
      .returning();
    accountId = account!.id;

    async function seedInboxWithBot(name: string, config: Record<string, unknown>) {
      const [inbox] = await db
        .insert(schema.inboxes)
        .values({ accountId, name, channelType: 'api' })
        .returning();
      const [bot] = await db
        .insert(schema.bots)
        .values({
          accountId,
          inboxId: inbox!.id,
          name: `${name}-bot`,
          botType: 'builtin',
          secret: 'v1:test:test:test',
          config,
        })
        .returning();
      return { inboxId: inbox!.id, botId: bot!.id };
    }

    ({ inboxId: inboxA, botId: botA } = await seedInboxWithBot('mig-a', { systemPrompt: PROMPT }));
    ({ inboxId: inboxB } = await seedInboxWithBot('mig-b', {}));
    ({ inboxId: inboxC } = await seedInboxWithBot('mig-c', {
      systemPrompt: 'já migrado',
      migratedToPlaybook: true,
    }));
  });

  afterAll(async () => {
    if (accountId) await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
    await client.end({ timeout: 5 });
  });

  it('DRY_RUN lists exactly the one candidate and writes nothing', async () => {
    const report = await migrateBotsToPlaybooks(db, { dryRun: true, accountId });
    expect(report.dryRun).toBe(true);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({ inboxId: inboxA, botId: botA, action: 'migrate' });
    expect(report.migrated).toBe(0);

    const playbooks = await db
      .select()
      .from(schema.inboxPlaybooks)
      .where(eq(schema.inboxPlaybooks.inboxId, inboxA));
    expect(playbooks).toHaveLength(0);
  });

  it('LIVE run migrates the candidate: playbook v1 + version row + bot marked', async () => {
    const report = await migrateBotsToPlaybooks(db, { dryRun: false, accountId });
    expect(report.migrated).toBe(1);

    const [playbook] = await db
      .select()
      .from(schema.inboxPlaybooks)
      .where(eq(schema.inboxPlaybooks.inboxId, inboxA));
    expect(playbook).toMatchObject({ content: PROMPT, version: 1 });
    expect(playbook!.etag).toHaveLength(16);

    const versions = await db
      .select()
      .from(schema.inboxPlaybookVersions)
      .where(eq(schema.inboxPlaybookVersions.inboxId, inboxA));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, content: PROMPT });

    const [bot] = await db.select().from(schema.bots).where(eq(schema.bots.id, botA));
    expect((bot!.config as Record<string, unknown>).migratedToPlaybook).toBe(true);
    // Original prompt is kept (backward compat — migration only marks).
    expect((bot!.config as Record<string, unknown>).systemPrompt).toBe(PROMPT);
  });

  it('LIVE run is idempotent: second run migrates 0', async () => {
    const report = await migrateBotsToPlaybooks(db, { dryRun: false, accountId });
    expect(report.migrated).toBe(0);
    expect(report.candidates).toHaveLength(0);

    const versions = await db
      .select()
      .from(schema.inboxPlaybookVersions)
      .where(eq(schema.inboxPlaybookVersions.inboxId, inboxA));
    expect(versions).toHaveLength(1);
  });

  it('never touches the empty-config or already-migrated inboxes', async () => {
    for (const inboxId of [inboxB, inboxC]) {
      const rows = await db
        .select()
        .from(schema.inboxPlaybooks)
        .where(eq(schema.inboxPlaybooks.inboxId, inboxId));
      expect(rows).toHaveLength(0);
    }
  });
});
