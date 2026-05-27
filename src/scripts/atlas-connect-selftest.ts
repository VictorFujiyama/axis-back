import 'dotenv/config';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * [Connect Flow / Phase 12.2 — T-11] Offline self-test for per-account connector
 * routing.
 *
 * The whole point of the auto-provision model (spec G3/G5) is that emit/inbound
 * resolve the org id + HMAC secret PER ACCOUNT from `atlas_connections`, and that
 * an account WITHOUT a connection emits nothing (the anti-leak rule). This script
 * proves that routing end-to-end without any network or real DB:
 *   - account A has a (fake, encrypted-in-memory) connection → `getConnectorForAccount`
 *     resolves a `messaging` connector stamped with A's org, and the stored secret
 *     decrypts back to A's HMAC.
 *   - account B has no connection → `getConnectorForAccount` returns `null`.
 *
 * No Atlas is contacted (the handshake/emit are not exercised here); `app.db` is a
 * stub returning the queued rows, so this runs fully offline. Run with
 *   pnpm tsx src/scripts/atlas-connect-selftest.ts
 * It prints a PASS/FAIL per check and exits non-zero if any check fails. Placement
 * in `src/scripts/` keeps it under the type-check gate (mirrors atlas-handshake.ts).
 */

const DUMMY_ATLAS_URL = 'https://atlas-company-os.vercel.app';

// Two axis accounts: A is provisioned (has an `atlas_connections` row), B is not.
const ACCOUNT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ACCOUNT_B = 'bbbbbbbb-5555-6666-7777-888888888888';
const ORG_A = 'f4c373d8-fb00-4423-91f1-e1380669a7d2';
const HMAC_A = 'a'.repeat(48);
const MCP_A = 'mcp-bearer-account-a';

/**
 * Build a `FastifyInstance` stub whose `app.db` returns `rows` for the single
 * `getConnection` lookup it performs (`select → from → where → limit`), with no
 * real DB and no network. `app.queues` is a no-op — the self-test never emits, so
 * the connector's `queueAdapter` is never invoked.
 */
function makeApp(rows: unknown[]): FastifyInstance {
  const limit = () => Promise.resolve(rows);
  const where = () => ({ limit });
  const from = () => ({ where });
  const select = () => ({ from });
  const getQueue = () => ({ add: async () => undefined });
  return { db: { select }, queues: { getQueue } } as unknown as FastifyInstance;
}

function logCheck(ok: boolean, label: string): boolean {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}`);
  return ok;
}

/** Runs the routing checks and returns true when all pass. Exported so the guard
 * below only fires the script when invoked directly (not on import). */
export async function runSelfTest(): Promise<boolean> {
  // Connect Flow keeps ATLAS_URL global (spec §7) as the connector's master
  // switch; `getConnectorForAccount` throws without it. Default a dummy so this
  // runs fully offline — no Atlas is contacted, we only exercise per-account
  // routing. Set BEFORE the dynamic imports so `config.ts` parses it in (a static
  // import would snapshot the config before this line runs).
  process.env.ATLAS_URL ??= DUMMY_ATLAS_URL;

  const { encryptJSON } = await import('../crypto');
  const { getConnection } = await import('../modules/atlas-events/connections');
  const { getConnectorForAccount } = await import('../modules/atlas-events/connector');

  // A stored row for account A, with secrets encrypted exactly as `upsertConnection` writes them.
  const rowA = {
    id: '11111111-2222-3333-4444-555555555555',
    atlasAccountId: ACCOUNT_A,
    atlasOrgId: ORG_A,
    secretsEnc: encryptJSON({ hmacSecret: HMAC_A, mcpBearer: MCP_A }),
    status: 'active' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const checks: boolean[] = [];

  // Account A — provisioned: the per-account connector resolves to A's org.
  const connA = await getConnectorForAccount(makeApp([rowA]), ACCOUNT_A);
  checks.push(logCheck(connA !== null, 'account A resolves a connector'));
  checks.push(logCheck(connA?.orgId === ORG_A, `connector A bound to org ${ORG_A}`));
  checks.push(logCheck(connA?.app === 'messaging', "connector A is the 'messaging' app"));

  // Account A — the secret routes through: the stored secret decrypts to A's HMAC.
  // `getConnectorForAccount` builds the connector from exactly this view but keeps
  // `hmacSecret` private, so the secret is asserted via the store view.
  const viewA = await getConnection(makeApp([rowA]).db, ACCOUNT_A);
  checks.push(logCheck(viewA?.secrets.hmacSecret === HMAC_A, 'account A secret decrypts to the right HMAC'));
  checks.push(logCheck(viewA?.atlasOrgId === ORG_A, 'account A connection carries the right org'));

  // Account B — not provisioned: no connection → no connector (anti-leak).
  const connB = await getConnectorForAccount(makeApp([]), ACCOUNT_B);
  checks.push(logCheck(connB === null, 'account B (no connection) resolves to null'));
  const viewB = await getConnection(makeApp([]).db, ACCOUNT_B);
  checks.push(logCheck(viewB === null, 'account B has no stored connection'));

  return checks.every(Boolean);
}

async function main(): Promise<void> {
  console.log('[atlas-connect-selftest] per-account connector routing (offline, no Atlas):');
  const ok = await runSelfTest();
  if (ok) {
    console.log('PASS — per-account routing resolves provisioned accounts and isolates the rest.');
  } else {
    console.error('FAIL — see the checks above.');
    process.exit(1);
  }
}

/** Run only when invoked directly (`tsx src/scripts/...`), so importing this
 * module in tests doesn't fire the self-test. */
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
    console.error('[atlas-connect-selftest] failed:', err);
    process.exit(1);
  });
}
