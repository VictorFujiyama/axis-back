import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';
import { encryptJSON } from '../../../crypto';
import {
  deleteConnection,
  getConnection,
  getConnectionByOrg,
  upsertConnection,
  type ConnectionSecrets,
} from '../connections';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORG_ID = 'f4c373d8-fb00-4423-91f1-e1380669a7d2';
const SECRETS: ConnectionSecrets = { hmacSecret: 'h'.repeat(48), mcpBearer: 'bearer-token-123' };

/** A stored row as it would come back from the DB (secrets already encrypted). */
function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    atlasAccountId: ACCOUNT_ID,
    atlasOrgId: ORG_ID,
    secretsEnc: encryptJSON(SECRETS),
    status: 'pending' as const,
    createdAt: new Date('2026-05-27T00:00:00Z'),
    updatedAt: new Date('2026-05-27T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Mock `db.insert(...).values(...).onConflictDoUpdate(...).returning()`. Captures the `values()` payload
 * so tests can assert secrets were encrypted (not stored in the clear) before hitting the DB.
 */
function makeInsertDb(returnRows: unknown[]) {
  const values = vi.fn();
  const returning = vi.fn().mockResolvedValue(returnRows);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  values.mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as unknown as DB, insert, values, onConflictDoUpdate };
}

/** Mock `db.select().from(...).where(...).limit(...)`. */
function makeSelectDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DB, select, where };
}

/** Mock `db.delete(...).where(...).returning(...)`. */
function makeDeleteDb(deletedRows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(deletedRows);
  const where = vi.fn().mockReturnValue({ returning });
  const del = vi.fn().mockReturnValue({ where });
  return { db: { delete: del } as unknown as DB, del, where, returning };
}

describe('upsertConnection', () => {
  it('encrypts secrets before storing and returns the decrypted view', async () => {
    const { db, values } = makeInsertDb([makeRow()]);

    const view = await upsertConnection(db, {
      atlasAccountId: ACCOUNT_ID,
      atlasOrgId: ORG_ID,
      secrets: SECRETS,
    });

    // The payload handed to the DB must carry an encrypted blob, never the raw secrets.
    const stored = values.mock.calls[0]![0] as { secretsEnc: string };
    expect(stored.secretsEnc).toMatch(/^v1:/);
    expect(stored.secretsEnc).not.toContain(SECRETS.hmacSecret);
    expect(stored.secretsEnc).not.toContain(SECRETS.mcpBearer);

    // The returned view exposes the round-tripped (decrypted) secrets.
    expect(view.secrets).toEqual(SECRETS);
    expect(view.atlasAccountId).toBe(ACCOUNT_ID);
    expect(view.status).toBe('pending');
  });

  it('defaults status to pending and honors an explicit status', async () => {
    const pending = makeInsertDb([makeRow()]);
    await upsertConnection(pending.db, {
      atlasAccountId: ACCOUNT_ID,
      atlasOrgId: ORG_ID,
      secrets: SECRETS,
    });
    expect((pending.values.mock.calls[0]![0] as { status: string }).status).toBe('pending');

    const active = makeInsertDb([makeRow({ status: 'active' })]);
    const view = await upsertConnection(active.db, {
      atlasAccountId: ACCOUNT_ID,
      atlasOrgId: ORG_ID,
      secrets: SECRETS,
      status: 'active',
    });
    expect((active.values.mock.calls[0]![0] as { status: string }).status).toBe('active');
    expect(view.status).toBe('active');
  });

  it('upserts on the account unique constraint (idempotent re-register)', async () => {
    const { db, onConflictDoUpdate } = makeInsertDb([makeRow()]);
    await upsertConnection(db, { atlasAccountId: ACCOUNT_ID, atlasOrgId: ORG_ID, secrets: SECRETS });
    const arg = onConflictDoUpdate.mock.calls[0]![0] as { target: unknown; set: Record<string, unknown> };
    expect(arg.set).toMatchObject({ atlasOrgId: ORG_ID });
    expect(arg.set.secretsEnc).toMatch(/^v1:/);
    expect(arg.set.updatedAt).toBeInstanceOf(Date);
  });
});

describe('getConnection', () => {
  it('returns the decrypted view for an account', async () => {
    const { db, where } = makeSelectDb([makeRow()]);
    const view = await getConnection(db, ACCOUNT_ID);
    expect(view).not.toBeNull();
    expect(view!.secrets).toEqual(SECRETS);
    expect(where).toHaveBeenCalledOnce();
  });

  it('returns null when no row exists', async () => {
    const { db } = makeSelectDb([]);
    expect(await getConnection(db, ACCOUNT_ID)).toBeNull();
  });
});

describe('getConnectionByOrg', () => {
  it('returns the decrypted view for an org', async () => {
    const { db } = makeSelectDb([makeRow()]);
    const view = await getConnectionByOrg(db, ORG_ID);
    expect(view!.atlasOrgId).toBe(ORG_ID);
    expect(view!.secrets).toEqual(SECRETS);
  });

  it('returns null when the org has no connection', async () => {
    const { db } = makeSelectDb([]);
    expect(await getConnectionByOrg(db, ORG_ID)).toBeNull();
  });
});

describe('deleteConnection', () => {
  it('deletes by org and reports rows removed', async () => {
    const { db, returning } = makeDeleteDb([{ id: 'x' }]);
    const n = await deleteConnection(db, { atlasOrgId: ORG_ID });
    expect(n).toBe(1);
    expect(returning).toHaveBeenCalledOnce();
  });

  it('deletes by account', async () => {
    const { db } = makeDeleteDb([{ id: 'x' }]);
    expect(await deleteConnection(db, { atlasAccountId: ACCOUNT_ID })).toBe(1);
  });

  it('is idempotent (no rows removed = 0)', async () => {
    const { db } = makeDeleteDb([]);
    expect(await deleteConnection(db, { atlasOrgId: ORG_ID })).toBe(0);
  });
});
