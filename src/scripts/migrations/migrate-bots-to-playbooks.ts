import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createDb, schema, type DB } from '@blossom/db';

// Fase 3 T-A.2 — backfill inbox_playbooks (+ inbox_playbook_versions v1) from
// bots that still carry their prompt inline in `config.systemPrompt`.
//
// Usage:
//   DRY_RUN=true  DATABASE_URL=... tsx src/scripts/migrations/migrate-bots-to-playbooks.ts
//   DRY_RUN=false DATABASE_URL=... tsx src/scripts/migrations/migrate-bots-to-playbooks.ts
//
// DRY_RUN defaults to TRUE — a live run requires the explicit `DRY_RUN=false`.
// Idempotent: bots already marked `config.migratedToPlaybook=true` are ignored,
// and inboxes that already have an `inbox_playbooks` row are skipped (the bot
// is still marked migrated on live runs so reruns converge to zero work).
// The original `config.systemPrompt` is never deleted (backward compat).

export interface MigrationCandidate {
  action: 'migrate' | 'skip-existing-playbook';
  inboxId: string;
  botId: string;
  botName: string;
  promptLength: number;
  dryRun: boolean;
}

export interface MigrationReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  candidates: MigrationCandidate[];
  migrated: number;
  skippedExistingPlaybook: number;
}

export interface MigrateOptions {
  dryRun: boolean;
  /** Restrict to a single account — used by tests to avoid touching dev data. */
  accountId?: string;
  log?: (line: string) => void;
}

function etagFor(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export async function migrateBotsToPlaybooks(
  db: DB,
  options: MigrateOptions,
): Promise<MigrationReport> {
  const { dryRun, accountId, log = console.log } = options;
  const startedAt = new Date().toISOString();

  const conditions = [
    sql`${schema.bots.config} ->> 'systemPrompt' is not null`,
    sql`length(${schema.bots.config} ->> 'systemPrompt') > 0`,
    sql`(${schema.bots.config} ->> 'migratedToPlaybook')::boolean is not true`,
    isNull(schema.inboxes.deletedAt),
  ];
  if (accountId) conditions.push(eq(schema.bots.accountId, accountId));

  const rows = await db
    .select({
      botId: schema.bots.id,
      botName: schema.bots.name,
      inboxId: schema.bots.inboxId,
      systemPrompt: sql<string>`${schema.bots.config} ->> 'systemPrompt'`,
      existingPlaybook: schema.inboxPlaybooks.inboxId,
    })
    .from(schema.bots)
    .innerJoin(schema.inboxes, eq(schema.bots.inboxId, schema.inboxes.id))
    .leftJoin(schema.inboxPlaybooks, eq(schema.inboxPlaybooks.inboxId, schema.bots.inboxId))
    .where(and(...conditions))
    .orderBy(schema.bots.createdAt);

  const candidates: MigrationCandidate[] = [];
  let migrated = 0;
  let skippedExistingPlaybook = 0;
  const seenInboxes = new Set<string>();

  for (const row of rows) {
    const hasPlaybook = row.existingPlaybook !== null || seenInboxes.has(row.inboxId);
    seenInboxes.add(row.inboxId);
    const candidate: MigrationCandidate = {
      action: hasPlaybook ? 'skip-existing-playbook' : 'migrate',
      inboxId: row.inboxId,
      botId: row.botId,
      botName: row.botName,
      promptLength: row.systemPrompt.length,
      dryRun,
    };
    candidates.push(candidate);
    log(JSON.stringify({ ...candidate, currentVersion: hasPlaybook ? null : 1 }));

    if (dryRun) continue;

    await db.transaction(async (tx) => {
      if (!hasPlaybook) {
        await tx.insert(schema.inboxPlaybooks).values({
          inboxId: row.inboxId,
          content: row.systemPrompt,
          etag: etagFor(row.systemPrompt),
          version: 1,
        });
        await tx.insert(schema.inboxPlaybookVersions).values({
          inboxId: row.inboxId,
          version: 1,
          content: row.systemPrompt,
          note: 'Migrado de bot.config.systemPrompt',
        });
      }
      await tx
        .update(schema.bots)
        .set({
          config: sql`${schema.bots.config} || '{"migratedToPlaybook": true}'::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.bots.id, row.botId));
    });

    if (hasPlaybook) skippedExistingPlaybook += 1;
    else migrated += 1;
  }

  if (dryRun) {
    skippedExistingPlaybook = candidates.filter(
      (c) => c.action === 'skip-existing-playbook',
    ).length;
  }

  return {
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidates,
    migrated,
    skippedExistingPlaybook,
  };
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN !== 'false';
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-bots-to-playbooks] DATABASE_URL is required.');
    process.exit(1);
  }
  const { db, client } = createDb(url);
  try {
    const report = await migrateBotsToPlaybooks(db, {
      dryRun,
      log: (line) => console.error(line),
    });
    // Machine-readable report on stdout (logs go to stderr).
    console.log(JSON.stringify(report, null, 2));
    console.error(
      `[migrate-bots-to-playbooks] ${dryRun ? 'DRY_RUN' : 'LIVE'}: ` +
        `${report.candidates.length} candidates, ${report.migrated} migrated, ` +
        `${report.skippedExistingPlaybook} skipped (existing playbook).`,
    );
  } finally {
    await client.end();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error('[migrate-bots-to-playbooks] failed:', err);
    process.exit(1);
  });
}
