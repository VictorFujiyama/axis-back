import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type AnyColumn, type SQL, and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { verifyRequest, type ConnectorEvent } from '@atlas/connectors';
import { schema, type DB } from '@blossom/db';
import { config } from '../../config';
import {
  buildContactEvent,
  buildConversationTurnEvent,
} from '../atlas-events/build-connector-event';
import { getConnectionByOrg } from '../atlas-events/connections';

/**
 * Phase 12.2 — history backfill route (`GET /atlas-connector/backfill`, Berg
 * doc Phase 4e). Atlas's `backfill-app` worker walks pages until `nextCursor`
 * is null, re-entering each event into the standard pipeline (idempotent,
 * L-603). Auth: a GET signs the empty body (L-607); `verifyRequest` never
 * throws (L-612) — map `.reason` to 401.
 *
 * Per-account (Connect Flow, T-06): the HMAC secret, the org id stamped on
 * rebuilt envelopes, and the account that scopes the walk all come from the
 * connection resolved by the signed `x-atlas-org-id` header
 * (`getConnectionByOrg`) — no global `ATLAS_ORG_ID`/`ATLAS_SOURCE_ACCOUNT_ID`.
 * An org with no connection → 401. The old "verified org ≠ ours" check (L-611)
 * is now implicit: we look the secret up BY the header org, so a verified
 * request is by construction for that org's account.
 *
 * Contacts-first (spec §12.10.06, L-605): `?phase=contacts` (default) before
 * `?phase=messages` so turns resolve to a real entity, not a phantom (L-604).
 * Anti-leak P0 (L-615): both walks hard-filter `accountId =
 * connection.atlasAccountId` (both tables carry it directly — no JOIN). Cursor:
 * opaque `base64url(JSON({afterCreatedAt, afterId}))` keyset on `(created_at,
 * id)`; Drizzle has no row-tuple compare, so `> a OR (= a AND id > b)`, fetching
 * `limit + 1` to detect more. Envelopes reuse the T-004a builders (pre-validated),
 * threaded with the connection's org id.
 */

export interface DecodedCursor {
  afterCreatedAt: string;
  afterId: string;
}

type BackfillPhase = 'contacts' | 'messages';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;

export function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode an opaque cursor; returns null on any malformed input (→ 400). */
export function decodeCursor(s: string): DecodedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as DecodedCursor).afterCreatedAt === 'string' &&
      typeof (parsed as DecodedCursor).afterId === 'string'
    ) {
      return parsed as DecodedCursor;
    }
    return null;
  } catch {
    return null;
  }
}

interface KeysetRow {
  id: string;
  createdAt: Date;
}

/** Split the `limit + 1` fetch into the page + the next cursor. */
function paginate<T extends KeysetRow>(
  rows: T[],
  limit: number,
): { page: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ afterCreatedAt: last.createdAt.toISOString(), afterId: last.id })
      : null;
  return { page, nextCursor };
}

function keysetCond(
  createdAtCol: AnyColumn,
  idCol: AnyColumn,
  cursor: DecodedCursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const after = new Date(cursor.afterCreatedAt);
  return or(
    gt(createdAtCol, after),
    and(eq(createdAtCol, after), gt(idCol, cursor.afterId)),
  );
}

export interface BackfillPageInput {
  db: DB;
  phase: BackfillPhase;
  cursor: DecodedCursor | null;
  limit: number;
  accountId: string;
  buildContact: (id: string) => Promise<ConnectorEvent>;
  buildTurn: (input: { conversationId: string; messageId: string }) => Promise<ConnectorEvent>;
}

/** Fetch + build one page of the backfill walk for the requested phase. */
export async function backfillPage(
  input: BackfillPageInput,
): Promise<{ events: ConnectorEvent[]; nextCursor: string | null }> {
  const { db, phase, cursor, limit, accountId } = input;
  const events: ConnectorEvent[] = [];

  if (phase === 'contacts') {
    const c = schema.contacts;
    const rows: KeysetRow[] = await db
      .select({ id: c.id, createdAt: c.createdAt })
      .from(c)
      .where(and(eq(c.accountId, accountId), isNull(c.deletedAt), keysetCond(c.createdAt, c.id, cursor)))
      .orderBy(asc(c.createdAt), asc(c.id))
      .limit(limit + 1);
    const { page, nextCursor } = paginate(rows, limit);
    for (const r of page) events.push(await input.buildContact(r.id));
    return { events, nextCursor };
  }

  const m = schema.messages;
  const rows: Array<KeysetRow & { conversationId: string }> = await db
    .select({ id: m.id, createdAt: m.createdAt, conversationId: m.conversationId })
    .from(m)
    .where(and(eq(m.accountId, accountId), keysetCond(m.createdAt, m.id, cursor)))
    .orderBy(asc(m.createdAt), asc(m.id))
    .limit(limit + 1);
  const { page, nextCursor } = paginate(rows, limit);
  for (const r of page) {
    events.push(await input.buildTurn({ conversationId: r.conversationId, messageId: r.id }));
  }
  return { events, nextCursor };
}

function headerValue(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export interface BackfillRouteOpts {
  /** Injectable builders for tests; default to the real T-004a helpers. */
  buildContact?: (id: string) => Promise<ConnectorEvent>;
  buildTurn?: (input: { conversationId: string; messageId: string }) => Promise<ConnectorEvent>;
}

export async function atlasBackfillRoutes(
  app: FastifyInstance,
  opts: BackfillRouteOpts = {},
): Promise<void> {
  // Global on/off only (T-10 retires this gate). The secret/org/account are now
  // resolved per request from the connection, not the boot env.
  if (!config.ATLAS_CONNECTOR_ENABLED) {
    return;
  }

  app.get('/atlas-connector/backfill', async (req, reply) => {
    // Resolve the org's connection (→ secret, account, org id) from the signed
    // header before verifying. No connection → 401.
    const orgHeader = headerValue(req, 'x-atlas-org-id');
    const connection = orgHeader ? await getConnectionByOrg(app.db, orgHeader) : null;
    if (!connection) return reply.code(401).send({ ok: false, error: 'unknown org' });

    // GET signs the empty body (L-607): the bytes we verify must equal what
    // Atlas signed, which is ''. org-mismatch is implicit — the secret was
    // looked up by the header org.
    const verify = verifyRequest(
      '',
      headerValue(req, 'x-atlas-signature'),
      orgHeader,
      connection.secrets.hmacSecret,
    );
    if (!verify.ok) return reply.code(401).send({ ok: false, error: verify.reason });

    const q = req.query as Record<string, string | undefined>;
    const phase: BackfillPhase = q.phase === 'messages' ? 'messages' : 'contacts';
    const parsedLimit = Number.parseInt(q.limit ?? '', 10);
    const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_LIMIT, 1), MAX_LIMIT);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return reply.code(400).send({ ok: false, error: 'malformed-cursor' });

    // Builders stamp the connection's org id (T-04); tests inject their own.
    const orgId = connection.atlasOrgId;
    const buildContact =
      opts.buildContact ?? ((id: string) => buildContactEvent(app.db, { contactId: id, orgId }));
    const buildTurn =
      opts.buildTurn ??
      ((i: { conversationId: string; messageId: string }) =>
        buildConversationTurnEvent(app.db, { ...i, orgId }));

    const { events, nextCursor } = await backfillPage({
      db: app.db,
      phase,
      cursor,
      limit,
      accountId: connection.atlasAccountId,
      buildContact,
      buildTurn,
    });
    return reply.send({ events, nextCursor });
  });
}
