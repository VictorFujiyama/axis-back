import 'dotenv/config';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORG_ID_HEADER, SIGNATURE_HEADER, signRequest } from '@atlas/connectors';
import { config } from '../config';

/**
 * [Phase 12.2 — Phase 6] One-time connector handshake.
 *
 * Signs an EMPTY body (handshake carries no payload — the signed
 * `${t}.${orgId}.` proves possession of the HMAC secret; L-601/L-607) and POSTs
 * it to Atlas's handshake endpoint. On success Atlas flips the connector row
 * from `pending` to `active` (the green badge in the admin UI).
 *
 * Read-only on axis-back: touches no local DB, only calls Atlas. Idempotent —
 * re-running an already-active connector just re-confirms `active`. Run with
 *   pnpm tsx src/scripts/atlas-handshake.ts [--dry-run]
 * `--dry-run` signs + prints the request without POSTing, so config/signing can
 * be verified without flipping the connector. Placement in `src/scripts/` (not
 * top-level `scripts/`) keeps it under the type-check gate and ships it to
 * Render where Victor runs it post-deploy (L-618).
 */

const HANDSHAKE_PATH = '/api/connectors/messaging/handshake';

export interface HandshakeOpts {
  atlasUrl: string;
  orgId: string;
  hmacSecret: string;
  dryRun?: boolean;
  /** Injectable for tests; production omits it. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic signatures in tests. */
  now?: number;
  log?: (msg: string) => void;
}

export interface HandshakeResponse {
  ok: boolean;
  status?: string;
  connector?: unknown;
  config?: unknown;
  [k: string]: unknown;
}

/**
 * Sign an empty body and POST the handshake. Returns the parsed response, or
 * `null` on a dry-run (nothing sent). Throws on a non-2xx response or `ok:false`;
 * an `ok:true` response with a non-`active` status warns but is returned (the
 * handshake itself succeeded — Victor can inspect the reported state).
 */
export async function runHandshake(opts: HandshakeOpts): Promise<HandshakeResponse | null> {
  const log = opts.log ?? (() => {});
  const rawBody = ''; // handshake has no payload — sign the empty string (L-607).
  const { signature, orgIdHeader } = signRequest(rawBody, opts.orgId, opts.hmacSecret, opts.now);
  const url = `${opts.atlasUrl.replace(/\/+$/, '')}${HANDSHAKE_PATH}`;

  if (opts.dryRun) {
    log(`dry-run — would POST ${url}`);
    log(`  ${SIGNATURE_HEADER}: ${signature}`);
    log(`  ${ORG_ID_HEADER}: ${orgIdHeader}`);
    return null;
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SIGNATURE_HEADER]: signature,
      [ORG_ID_HEADER]: orgIdHeader,
    },
    body: rawBody,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Atlas handshake failed: ${res.status} ${errBody}`);
  }

  const body = (await res.json()) as HandshakeResponse;
  if (body.ok !== true) {
    throw new Error(`Atlas handshake returned ok:false — ${JSON.stringify(body)}`);
  }
  if (body.status !== 'active') {
    log(`WARNING: handshake ok but status is '${body.status ?? 'unknown'}', expected 'active'.`);
  } else {
    log("handshake ok — connector status='active'.");
  }
  return body;
}

export interface ParsedArgs {
  dryRun: boolean;
}

/** Parse `--dry-run` (the only flag). */
export function parseArgs(argv: string[]): ParsedArgs {
  return { dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const { ATLAS_URL, ATLAS_ORG_ID, ATLAS_HMAC_SECRET } = config;
  if (!ATLAS_URL || !ATLAS_ORG_ID || !ATLAS_HMAC_SECRET) {
    console.error(
      'Missing connector config: ATLAS_URL, ATLAS_ORG_ID and ATLAS_HMAC_SECRET are all required.',
    );
    process.exit(1);
  }

  console.log(`[atlas-handshake] org=${ATLAS_ORG_ID}${dryRun ? ' (dry-run)' : ''}`);
  const result = await runHandshake({
    atlasUrl: ATLAS_URL,
    orgId: ATLAS_ORG_ID,
    hmacSecret: ATLAS_HMAC_SECRET,
    dryRun,
    log: (m) => console.log(`  ${m}`),
  });
  if (result) console.log(`[atlas-handshake] response: ${JSON.stringify(result)}`);
}

/** Run only when invoked directly (`tsx src/scripts/...`), so importing this
 * module in tests doesn't fire a real handshake. */
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
    console.error('[atlas-handshake] failed:', err);
    process.exit(1);
  });
}
