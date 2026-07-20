import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { createDb, type DB } from '../../client';
import * as schema from '../index';

// Integration test — runs against the local dev Postgres (blossom-postgres,
// :5434) with migrations applied. Skips itself when the DB is unreachable so
// `pnpm test` stays green on machines without the docker compose stack up.
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

describe.skipIf(!dbUp)('inbox_playbook_versions schema', () => {
  let db: DB;
  let client: postgres.Sql;
  let inboxId: string;

  beforeAll(async () => {
    ({ db, client } = createDb(DB_URL));
    const [inbox] = await db
      .insert(schema.inboxes)
      .values({ name: 'ipv-schema-test', channelType: 'api' })
      .returning();
    inboxId = inbox!.id;
  });

  afterAll(async () => {
    if (inboxId) await db.delete(schema.inboxes).where(eq(schema.inboxes.id, inboxId));
    await client.end({ timeout: 5 });
  });

  it('inserts version=1 with defaults (id, createdAt)', async () => {
    const [row] = await db
      .insert(schema.inboxPlaybookVersions)
      .values({ inboxId, version: 1, content: 'v1 playbook content' })
      .returning();
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row!.version).toBe(1);
    expect(row!.content).toBe('v1 playbook content');
    expect(row!.note).toBeNull();
    expect(row!.createdBy).toBeNull();
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate (inbox_id, version) with a unique violation', async () => {
    await expect(
      db
        .insert(schema.inboxPlaybookVersions)
        .values({ inboxId, version: 1, content: 'duplicate v1' }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('cascade-deletes versions when the inbox is deleted', async () => {
    const [inbox] = await db
      .insert(schema.inboxes)
      .values({ name: 'ipv-cascade-test', channelType: 'api' })
      .returning();
    await db
      .insert(schema.inboxPlaybookVersions)
      .values({ inboxId: inbox!.id, version: 1, content: 'doomed' });

    await db.delete(schema.inboxes).where(eq(schema.inboxes.id, inbox!.id));

    const rows = await db
      .select()
      .from(schema.inboxPlaybookVersions)
      .where(eq(schema.inboxPlaybookVersions.inboxId, inbox!.id));
    expect(rows).toHaveLength(0);
  });
});
