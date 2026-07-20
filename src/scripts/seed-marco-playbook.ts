import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { createDb, schema, type DB } from '@blossom/db';

// Fase 3 T-B.2: seed idempotente do segundo playbook demo (Marco, fork formal
// do Yuji — packages/prompts/reply-bot-marco.md). Cria a inbox "Marco Demo"
// (canal 'api', sem credenciais), upserta inbox_playbooks e, quando a tabela
// inbox_playbook_versions já existir (Track A), grava o snapshot da versão.
// Rodar: pnpm tsx src/scripts/seed-marco-playbook.ts

export const MARCO_INBOX_NAME = 'Marco Demo';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MARCO_PLAYBOOK_PATH = path.join(repoRoot, 'packages/prompts/reply-bot-marco.md');

/** Both a full DB and a transaction satisfy the query surface used here. */
export type DbOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export interface SeedMarcoResult {
  inboxId: string;
  inboxAction: 'created' | 'kept';
  playbookAction: 'created' | 'updated' | 'unchanged';
  version: number;
  versionAction: 'inserted' | 'exists' | 'table-missing';
}

export function loadMarcoPlaybook(): string {
  return readFileSync(MARCO_PLAYBOOK_PATH, 'utf8');
}

export async function seedMarcoPlaybook(db: DbOrTx, content: string): Promise<SeedMarcoResult> {
  let [inbox] = await db
    .select()
    .from(schema.inboxes)
    .where(and(eq(schema.inboxes.name, MARCO_INBOX_NAME), isNull(schema.inboxes.deletedAt)))
    .limit(1);

  let inboxAction: SeedMarcoResult['inboxAction'] = 'kept';
  if (!inbox) {
    const [account] = await db
      .select()
      .from(schema.accounts)
      .orderBy(asc(schema.accounts.createdAt))
      .limit(1);
    let accountId = account?.id;
    if (!accountId) {
      const [created] = await db
        .insert(schema.accounts)
        .values({ name: 'Marco Demo' })
        .returning();
      accountId = created!.id;
    }

    const [created] = await db
      .insert(schema.inboxes)
      .values({
        accountId,
        name: MARCO_INBOX_NAME,
        channelType: 'api',
        config: { demo: true, persona: 'marco' },
      })
      .returning();
    inbox = created!;
    inboxAction = 'created';
  }

  // Mesmo formato de etag do PATCH /api/v1/inboxes/:id (sha256 truncado).
  const etag = createHash('sha256').update(content).digest('hex').slice(0, 16);

  const [existing] = await db
    .select()
    .from(schema.inboxPlaybooks)
    .where(eq(schema.inboxPlaybooks.inboxId, inbox.id))
    .limit(1);

  let playbookAction: SeedMarcoResult['playbookAction'];
  let version: number;
  if (!existing) {
    const [row] = await db
      .insert(schema.inboxPlaybooks)
      .values({ inboxId: inbox.id, content, etag })
      .returning();
    playbookAction = 'created';
    version = row!.version;
  } else if (existing.content === content) {
    playbookAction = 'unchanged';
    version = existing.version;
  } else {
    const [row] = await db
      .update(schema.inboxPlaybooks)
      .set({
        content,
        etag,
        version: sql`${schema.inboxPlaybooks.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.inboxPlaybooks.inboxId, inbox.id))
      .returning();
    playbookAction = 'updated';
    version = row!.version;
  }

  const versionAction = await snapshotVersion(db, inbox.id, version, content);
  return { inboxId: inbox.id, inboxAction, playbookAction, version, versionAction };
}

// A tabela inbox_playbook_versions nasce na Track A (fase-3.A), que roda em
// paralelo a esta. Snapshot é best-effort via SQL cru: se a tabela ainda não
// existe o seed segue funcionando e reporta 'table-missing'.
async function snapshotVersion(
  db: DbOrTx,
  inboxId: string,
  version: number,
  content: string,
): Promise<SeedMarcoResult['versionAction']> {
  const reg = (await db.execute(
    sql`select to_regclass('public.inbox_playbook_versions') as tbl`,
  )) as unknown as Array<{ tbl: string | null }>;
  if (reg[0]?.tbl == null) return 'table-missing';

  const existing = (await db.execute(sql`
    select id from inbox_playbook_versions
    where inbox_id = ${inboxId} and version = ${version}
    limit 1
  `)) as unknown as unknown[];
  if (existing.length > 0) return 'exists';

  await db.execute(sql`
    insert into inbox_playbook_versions (inbox_id, version, content, note)
    values (${inboxId}, ${version}, ${content}, 'seed-marco-playbook')
  `);
  return 'inserted';
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definido. Configure o .env ou exporte a variável.');
    process.exit(1);
  }

  const { db, client } = createDb(url);
  try {
    const result = await seedMarcoPlaybook(db, loadMarcoPlaybook());
    console.log(JSON.stringify({ script: 'seed-marco-playbook', ...result }, null, 2));
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
  });
}
