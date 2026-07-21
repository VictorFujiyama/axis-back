import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { createDb, schema, type DB } from '@blossom/db';
import { builtinBotConfigSchema } from '../../modules/bots/builtin-config';
import { configEtag } from '../../modules/bots/config-routes';

// Playbook deprecation (Task 9): one-shot que copia inbox_playbooks.content →
// bots.config.systemPrompt de cada bot builtin com playbookSource='local' e
// seta playbookSource='inline', gravando a primeira row do histórico em
// bots_config_versions. Idempotente: segunda rodada encontra 'inline' e não
// toca em nada. Bots com playbookSource='atlas' exigem revisão humana (o
// prompt mora no Atlas, não há o que copiar daqui) — só loga e conta em
// `manual`. A tabela inbox_playbooks NÃO é apagada aqui (Task 25 dropa).
//
// Rodar: pnpm tsx src/scripts/migrations/migrate-playbooks-to-bots.ts          (dry-run)
//        pnpm tsx src/scripts/migrations/migrate-playbooks-to-bots.ts --apply  (muta)

/** Both a full DB and a transaction satisfy the query surface used here. */
export type DbOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export interface MigrationStats {
  migrated: number;
  noop: number;
  manual: number;
}

export async function migratePlaybooksToBots(db: DbOrTx): Promise<MigrationStats> {
  const stats: MigrationStats = { migrated: 0, noop: 0, manual: 0 };

  const bots = await db
    .select()
    .from(schema.bots)
    .where(eq(schema.bots.botType, 'builtin'))
    .orderBy(asc(schema.bots.createdAt));

  for (const bot of bots) {
    const cfg = (bot.config ?? {}) as Record<string, unknown>;
    // Ausente = 'inline' (default do builtinBotConfigSchema).
    const source = (cfg.playbookSource as string | undefined) ?? 'inline';

    if (source === 'inline') {
      stats.noop += 1;
      continue;
    }
    if (source === 'atlas') {
      console.warn(
        `[migrate] bot ${bot.id} (${bot.name}): playbookSource='atlas' — revisão manual. ` +
          'O prompt mora no Atlas; copie-o pro config via PATCH /bots/:id/config.',
      );
      stats.manual += 1;
      continue;
    }

    // source === 'local'
    const [pb] = await db
      .select()
      .from(schema.inboxPlaybooks)
      .where(eq(schema.inboxPlaybooks.inboxId, bot.inboxId))
      .limit(1);
    if (!pb) {
      // Sem playbook o runtime já caía no fallback inline; nada a copiar.
      console.log(
        `[migrate] bot ${bot.id} (${bot.name}): playbookSource='local' sem row em inbox_playbooks — noop.`,
      );
      stats.noop += 1;
      continue;
    }

    // Valida a config resultante ANTES de escrever. Se o merge não passa no
    // schema (config incompleta, playbook > 10k chars), não dá pra gravar a
    // version row com segurança → revisão manual.
    const merged = builtinBotConfigSchema.safeParse({
      ...cfg,
      systemPrompt: pb.content,
      playbookSource: 'inline',
    });
    if (!merged.success) {
      console.warn(
        `[migrate] bot ${bot.id} (${bot.name}): config inválida pós-merge — revisão manual. ` +
          merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
      stats.manual += 1;
      continue;
    }

    let didMigrate = false;
    await db.transaction(async (tx) => {
      // Lock + recheck: se outra rodada concorrente já migrou, vira noop.
      const [locked] = await tx
        .select({ id: schema.bots.id, config: schema.bots.config })
        .from(schema.bots)
        .where(eq(schema.bots.id, bot.id))
        .limit(1)
        .for('update');
      const lockedSource = (locked?.config as Record<string, unknown> | undefined)?.playbookSource;
      if (!locked || lockedSource !== 'local') return;

      // jsonb_set em vez de replace total: preserva chaves extras que o
      // schema zod strip-aria (config é jsonb livre no banco).
      await tx.execute(sql`
        update bots
        set config = jsonb_set(
              jsonb_set(config, '{systemPrompt}', to_jsonb(${pb.content}::text)),
              '{playbookSource}', '"inline"'
            ),
            updated_at = now()
        where id = ${bot.id}
      `);

      // Tasks 7/8 podem já ter criado versões (PATCH/rollback em teste).
      // Decisão: appenda a PRÓXIMA versão em vez de pular — histórico linear
      // sempre registra o estado pós-migração. Sem versões prévias = v1.
      const [latest] = await tx
        .select({ version: schema.botsConfigVersions.version })
        .from(schema.botsConfigVersions)
        .where(eq(schema.botsConfigVersions.botId, bot.id))
        .orderBy(desc(schema.botsConfigVersions.version))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      await tx.insert(schema.botsConfigVersions).values({
        botId: bot.id,
        version: nextVersion,
        systemPrompt: merged.data.systemPrompt,
        model: merged.data.model,
        provider: merged.data.provider,
        temperature: String(merged.data.temperature),
        maxTokens: merged.data.maxTokens,
        etag: configEtag(merged.data),
      });

      didMigrate = true;
      console.log(
        `[migrate] bot ${bot.id} (${bot.name}): playbook (${pb.content.length} chars) → config.systemPrompt, version ${nextVersion}.`,
      );
    });

    if (didMigrate) {
      stats.migrated += 1;
    } else {
      stats.noop += 1;
    }
  }

  return stats;
}

class DryRunRollback extends Error {}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definido. Configure o .env ou exporte a variável.');
    process.exit(1);
  }

  const { db, client } = createDb(url);
  try {
    let stats: MigrationStats = { migrated: 0, noop: 0, manual: 0 };
    if (apply) {
      stats = await migratePlaybooksToBots(db);
    } else {
      // Dry-run: roda tudo numa transaction e desfaz. Os logs mostram o que
      // ACONTECERIA; nada persiste sem --apply.
      await db
        .transaction(async (tx) => {
          stats = await migratePlaybooksToBots(tx);
          throw new DryRunRollback('rollback');
        })
        .catch((err: unknown) => {
          if (!(err instanceof DryRunRollback)) throw err;
        });
      console.log('[migrate] DRY RUN — nada persistido. Rode com --apply pra mutar.');
    }
    console.log(
      `[migrate] done: migrated=${stats.migrated} noop=${stats.noop} manual=${stats.manual} apply=${apply}`,
    );
    if (stats.manual > 0) process.exitCode = 2;
  } finally {
    await client.end();
  }
}

const isDirectRun =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
