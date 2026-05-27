import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import { decryptJSON, encryptJSON } from '../../crypto';

/**
 * Per-account Atlas connector connection store (Connect Flow — auto-provision, Phase 12.2).
 *
 * One row per axis account in `atlas_connections` (see packages/db/src/schema/atlas-connections.ts).
 * The connector secrets (`hmacSecret`, `mcpBearer`) live encrypted in the `secrets_enc` column using
 * the same AES-256-GCM scheme the inbox channel secrets use (`encryptJSON`/`decryptJSON`, src/crypto.ts)
 * — never store them in the clear, never invent a new cipher.
 *
 * Lookups are by account (event emit, T-05) or by org (inbound `/atlas-events`, T-06). Every function
 * takes the `DB` handle explicitly (mirrors src/lib/audit.ts) so callers pass `app.db` and unit tests
 * pass a mock.
 */

export type ConnectionStatus = 'pending' | 'active' | 'error';

/** Decrypted connector secrets carried in `secrets_enc`. */
export interface ConnectionSecrets {
  hmacSecret: string;
  mcpBearer: string;
}

/** A connection with its secrets decrypted — what callers actually consume. */
export interface AtlasConnectionView {
  id: string;
  atlasAccountId: string;
  atlasOrgId: string;
  status: ConnectionStatus;
  secrets: ConnectionSecrets;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertConnectionInput {
  atlasAccountId: string;
  atlasOrgId: string;
  secrets: ConnectionSecrets;
  /** Defaults to 'pending' (handshake flips it to 'active'/'error' later, T-07). */
  status?: ConnectionStatus;
}

type ConnectionRow = typeof schema.atlasConnections.$inferSelect;

/** Decrypt `secrets_enc` and shape a stored row into the view callers use. */
function toView(row: ConnectionRow): AtlasConnectionView {
  return {
    id: row.id,
    atlasAccountId: row.atlasAccountId,
    atlasOrgId: row.atlasOrgId,
    status: row.status,
    secrets: decryptJSON<ConnectionSecrets>(row.secretsEnc),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Insert or update the connection for an axis account (unique on `atlas_account_id`).
 *
 * Idempotent: re-registering the same account overwrites the org/secrets/status in place. Secrets are
 * encrypted before they touch the DB. Returns the stored connection (decrypted).
 */
export async function upsertConnection(
  db: DB,
  input: UpsertConnectionInput,
): Promise<AtlasConnectionView> {
  const secretsEnc = encryptJSON(input.secrets);
  const status: ConnectionStatus = input.status ?? 'pending';
  const [row] = await db
    .insert(schema.atlasConnections)
    .values({
      atlasAccountId: input.atlasAccountId,
      atlasOrgId: input.atlasOrgId,
      secretsEnc,
      status,
    })
    .onConflictDoUpdate({
      target: schema.atlasConnections.atlasAccountId,
      set: {
        atlasOrgId: input.atlasOrgId,
        secretsEnc,
        status,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('upsertConnection: insert returned no row');
  return toView(row);
}

/** Resolve the connection bound to an axis account, or null if none. */
export async function getConnection(
  db: DB,
  accountId: string,
): Promise<AtlasConnectionView | null> {
  const [row] = await db
    .select()
    .from(schema.atlasConnections)
    .where(eq(schema.atlasConnections.atlasAccountId, accountId))
    .limit(1);
  return row ? toView(row) : null;
}

/**
 * Resolve the connection for an Atlas org, or null if none. Used by inbound `/atlas-events` (T-06) to
 * find the HMAC secret to verify against from the `x-atlas-org-id` header.
 */
export async function getConnectionByOrg(
  db: DB,
  orgId: string,
): Promise<AtlasConnectionView | null> {
  const [row] = await db
    .select()
    .from(schema.atlasConnections)
    .where(eq(schema.atlasConnections.atlasOrgId, orgId))
    .limit(1);
  return row ? toView(row) : null;
}

/**
 * Remove a connection, keyed by either Atlas org (deregister, T-08) or axis account. Idempotent:
 * deleting something that does not exist is a no-op. Returns the number of rows removed.
 */
export async function deleteConnection(
  db: DB,
  by: { atlasOrgId: string } | { atlasAccountId: string },
): Promise<number> {
  const where =
    'atlasOrgId' in by
      ? eq(schema.atlasConnections.atlasOrgId, by.atlasOrgId)
      : eq(schema.atlasConnections.atlasAccountId, by.atlasAccountId);
  const deleted = await db.delete(schema.atlasConnections).where(where).returning({
    id: schema.atlasConnections.id,
  });
  return deleted.length;
}
