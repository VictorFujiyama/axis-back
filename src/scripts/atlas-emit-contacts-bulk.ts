import 'dotenv/config';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type SQL, and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { AtlasConnector, type ConnectorEvent } from '@atlas/connectors';
import { createDb, schema, type DB } from '@blossom/db';
import { config } from '../config';
import { buildContactEvent } from '../modules/atlas-events/build-connector-event';

/**
 * [Phase 12.2 — Phase 4c] One-shot bulk emit of existing contacts to Atlas.
 * Run ONCE before going live so later `conversation_turn`s resolve to the same
 * entity instead of minting a phantom per message (L-605). Idempotent — Atlas
 * dedups on `(source_app, event_id)` (L-603), so re-running is safe.
 *
 * Uses a QUEUE-LESS `AtlasConnector` + `emitDirect({events})` for a real batch
 * POST (one POST per page). The singleton in `connector.ts` would instead fan
 * out to one BullMQ job per event via its `queueAdapter` — wrong for a seed (C2).
 *
 * Anti-leak P0 (L-615): hard-scoped to `ATLAS_SOURCE_ACCOUNT_ID` / `--account`;
 * refuses to run unscoped. Soft-deleted contacts are skipped. Placement deviates
 * from TASKS T-009 (`scripts/` → `src/scripts/`) so the type-check gate covers
 * it — rationale in findings/T009-bulk-contacts.md. Run with
 * `pnpm tsx src/scripts/atlas-emit-contacts-bulk.ts [--dry-run] [--batch=N] [--account=UUID]`.
 */

const MAX_BATCH = 1_000; // SDK §12.2.01 cap — larger batches must be chunked.
const DEFAULT_BATCH = 500;

export interface BulkEmitOpts {
  db: DB;
  /** Queue-less connector — only `emitDirect` is used (batch POST). */
  connector: Pick<AtlasConnector, 'emitDirect'>;
  /** Account scope (anti-leak P0). Empty/missing is rejected. */
  accountId: string;
  batchSize: number;
  dryRun: boolean;
  /** Builder, injectable for tests. Defaults to `buildContactEvent`. */
  buildEvent?: (contactId: string) => Promise<ConnectorEvent>;
  log?: (msg: string) => void;
}

export interface BulkEmitResult {
  contacts: number;
  /** Events POSTed (0 on dry-run). NOT a skip count — Atlas always 202s and
   * dedups silently worker-side (L-613). */
  queued: number;
  pages: number;
}

/** Walk the contacts table by a stable `(created_at, id)` cursor, building one
 * `contact` envelope per row and POSTing each page as a single batch. */
export async function emitContactsBulk(opts: BulkEmitOpts): Promise<BulkEmitResult> {
  if (!opts.accountId) {
    throw new Error(
      'emitContactsBulk: accountId required (anti-leak P0) — set ATLAS_SOURCE_ACCOUNT_ID or pass --account=<uuid>.',
    );
  }
  const log = opts.log ?? (() => {});
  const buildEvent =
    opts.buildEvent ?? ((id: string) => buildContactEvent(opts.db, { contactId: id }));

  let cursor: { createdAt: Date; id: string } | null = null;
  let pages = 0;
  let contacts = 0;
  let queued = 0;

  for (;;) {
    const cursorCond: SQL | undefined = cursor
      ? or(
          gt(schema.contacts.createdAt, cursor.createdAt),
          and(eq(schema.contacts.createdAt, cursor.createdAt), gt(schema.contacts.id, cursor.id)),
        )
      : undefined;

    const rows: Array<{ id: string; createdAt: Date }> = await opts.db
      .select({ id: schema.contacts.id, createdAt: schema.contacts.createdAt })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.accountId, opts.accountId),
          isNull(schema.contacts.deletedAt),
          cursorCond,
        ),
      )
      .orderBy(asc(schema.contacts.createdAt), asc(schema.contacts.id))
      .limit(opts.batchSize);

    if (rows.length === 0) break;
    pages += 1;

    const events: ConnectorEvent[] = [];
    for (const row of rows) events.push(await buildEvent(row.id));

    if (!opts.dryRun) {
      try {
        await opts.connector.emitDirect({ events });
      } catch (err) {
        const first = rows[0]?.id;
        const last = rows[rows.length - 1]?.id;
        throw new Error(
          `emitContactsBulk: batch POST failed on page ${pages} (contacts ${first}..${last}): ${
            (err as Error).message
          }. Re-run is idempotent — Atlas dedups on (source_app, event_id).`,
        );
      }
      queued += events.length;
    }

    contacts += rows.length;
    const tail = rows[rows.length - 1]!;
    cursor = { createdAt: tail.createdAt, id: tail.id };
    log(
      `page ${pages}: ${rows.length} contacts ${
        opts.dryRun ? 'built (dry-run, not sent)' : 'queued'
      } — cursor ${tail.id}`,
    );

    if (rows.length < opts.batchSize) break;
  }

  return { contacts, queued, pages };
}

export interface ParsedArgs {
  dryRun: boolean;
  batchSize: number;
  account: string | undefined;
}

/** Parse `--dry-run`, `--batch=N` (clamped to [1, 1000]), `--account=UUID`.
 * Account defaults to `ATLAS_SOURCE_ACCOUNT_ID`. */
export function parseArgs(argv: string[], defaultAccount: string | undefined): ParsedArgs {
  const dryRun = argv.includes('--dry-run');
  const batchArg = argv.find((a) => a.startsWith('--batch='))?.split('=')[1];
  const parsed = batchArg ? Number.parseInt(batchArg, 10) : DEFAULT_BATCH;
  const batchSize = Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_BATCH, 1), MAX_BATCH);
  const account = argv.find((a) => a.startsWith('--account='))?.split('=')[1] ?? defaultAccount;
  return { dryRun, batchSize, account };
}

async function main(): Promise<void> {
  const { dryRun, batchSize, account } = parseArgs(process.argv.slice(2), config.ATLAS_SOURCE_ACCOUNT_ID);

  if (!account) {
    console.error(
      'Anti-leak refusal: no account scope. Set ATLAS_SOURCE_ACCOUNT_ID or pass --account=<uuid>.',
    );
    process.exit(1);
  }
  const { ATLAS_URL, ATLAS_ORG_ID, ATLAS_HMAC_SECRET } = config;
  if (!ATLAS_URL || !ATLAS_ORG_ID || !ATLAS_HMAC_SECRET) {
    console.error(
      'Missing connector config: ATLAS_URL, ATLAS_ORG_ID and ATLAS_HMAC_SECRET are all required.',
    );
    process.exit(1);
  }

  const { db, client } = createDb(config.DATABASE_URL);
  // Queue-less on purpose: emitDirect({events}) is a real batch POST (C2).
  const connector = new AtlasConnector({
    atlasBaseUrl: ATLAS_URL,
    app: 'messaging',
    orgId: ATLAS_ORG_ID,
    hmacSecret: ATLAS_HMAC_SECRET,
  });

  console.log(
    `[atlas-emit-contacts-bulk] account=${account} batch=${batchSize}${dryRun ? ' (dry-run)' : ''}`,
  );
  try {
    const result = await emitContactsBulk({
      db,
      connector,
      accountId: account,
      batchSize,
      dryRun,
      log: (m) => console.log(`  ${m}`),
    });
    console.log(
      `[atlas-emit-contacts-bulk] done: ${result.contacts} contacts over ${result.pages} pages, ${result.queued} queued.`,
    );
  } finally {
    await client.end();
  }
}

/** Run only when invoked directly (`tsx src/scripts/...`), so importing this
 * module in tests doesn't kick off a real bulk emit. */
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
    console.error('[atlas-emit-contacts-bulk] failed:', err);
    process.exit(1);
  });
}
