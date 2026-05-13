import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';

import { buildAtlasBotEmail, getOrCreateAtlasBotUser } from '../atlas-bot';

const TEST_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const BOT_USER_ROW = {
  id: '22222222-2222-2222-2222-222222222222',
  email: buildAtlasBotEmail(TEST_ACCOUNT_ID),
  name: 'Atlas Assistant',
};

/**
 * Build a drizzle mock that exercises both call sites of
 * `getOrCreateAtlasBotUser`:
 *   - `db.select(...).from(...).innerJoin(...).where(...).limit(...)` (lookup)
 *   - `db.transaction(cb)` with a `tx` exposing the same shape as `db` plus
 *     `.insert(...).values(...).onConflictDoNothing(...).returning(...)` and
 *     `.select(...).from(...).where(...).limit(...)` for the re-SELECT path.
 *
 * `lookupRows` resolves the JOIN-against-account_users lookup; `insertReturn`
 * is what `tx.insert(users)...returning()` resolves to (empty array simulates
 * a race that lost the ON CONFLICT). `reSelectRows` is consumed by the
 * post-conflict `tx.select(...).from(users).where(email).limit(1)` fallback.
 */
function makeDb(opts: {
  lookupRows: unknown[];
  insertReturn?: unknown[];
  reSelectRows?: unknown[];
}): {
  db: DB;
  insertUsersSpy: ReturnType<typeof vi.fn>;
  insertMembershipSpy: ReturnType<typeof vi.fn>;
  transactionSpy: ReturnType<typeof vi.fn>;
} {
  const lookupLimit = vi.fn().mockResolvedValue(opts.lookupRows);
  const lookupWhere = vi.fn().mockReturnValue({ limit: lookupLimit });
  const lookupInnerJoin = vi.fn().mockReturnValue({ where: lookupWhere });
  const lookupFrom = vi.fn().mockReturnValue({ innerJoin: lookupInnerJoin });
  const dbSelect = vi.fn().mockReturnValue({ from: lookupFrom });

  // Track the two insert call sites separately so tests can assert on each.
  const insertUsersReturning = vi.fn().mockResolvedValue(opts.insertReturn ?? []);
  const insertUsersOnConflict = vi
    .fn()
    .mockReturnValue({ returning: insertUsersReturning });
  const insertUsersValues = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing: insertUsersOnConflict });

  const insertMembershipOnConflict = vi.fn().mockResolvedValue(undefined);
  const insertMembershipValues = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing: insertMembershipOnConflict });

  const insertUsersSpy = vi.fn();
  const insertMembershipSpy = vi.fn();
  let insertCalls = 0;
  const txInsert = vi.fn().mockImplementation((table: unknown) => {
    insertCalls += 1;
    if (insertCalls === 1) {
      insertUsersSpy(table);
      return { values: insertUsersValues };
    }
    insertMembershipSpy(table);
    return { values: insertMembershipValues };
  });

  // Re-SELECT path inside the transaction (only used when ON CONFLICT loses
  // the race and `returning()` resolves to []).
  const txReSelectLimit = vi.fn().mockResolvedValue(opts.reSelectRows ?? []);
  const txReSelectWhere = vi.fn().mockReturnValue({ limit: txReSelectLimit });
  const txReSelectFrom = vi.fn().mockReturnValue({ where: txReSelectWhere });
  const txSelect = vi.fn().mockReturnValue({ from: txReSelectFrom });

  const tx = { insert: txInsert, select: txSelect };
  const transactionSpy = vi
    .fn()
    .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx));

  const db = {
    select: dbSelect,
    transaction: transactionSpy,
  } as unknown as DB;

  return { db, insertUsersSpy, insertMembershipSpy, transactionSpy };
}

describe('getOrCreateAtlasBotUser', () => {
  it('returns the existing bot user without opening a transaction (idempotent path)', async () => {
    const { db, transactionSpy } = makeDb({ lookupRows: [BOT_USER_ROW] });

    const result = await getOrCreateAtlasBotUser(db, TEST_ACCOUNT_ID);

    expect(result).toEqual(BOT_USER_ROW);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('creates the bot user and the account_users membership when none exists', async () => {
    const { db, transactionSpy, insertUsersSpy, insertMembershipSpy } = makeDb({
      lookupRows: [],
      insertReturn: [BOT_USER_ROW],
    });

    const result = await getOrCreateAtlasBotUser(db, TEST_ACCOUNT_ID);

    expect(result).toEqual(BOT_USER_ROW);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    // Two distinct inserts inside the transaction: users (1st), then
    // account_users (2nd). The helper does not call `.returning()` on the
    // membership insert, so the fact that we got here proves the awaited
    // chain finished cleanly.
    expect(insertUsersSpy).toHaveBeenCalledTimes(1);
    expect(insertMembershipSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers from a race: ON CONFLICT loses, helper re-SELECTs by email and still inserts membership', async () => {
    const { db, insertUsersSpy, insertMembershipSpy, transactionSpy } = makeDb({
      lookupRows: [],
      insertReturn: [], // simulate ON CONFLICT (email) DO NOTHING winning
      reSelectRows: [BOT_USER_ROW],
    });

    const result = await getOrCreateAtlasBotUser(db, TEST_ACCOUNT_ID);

    expect(result).toEqual(BOT_USER_ROW);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(insertUsersSpy).toHaveBeenCalledTimes(1);
    // Even though we lost the INSERT race, account_users still gets the
    // membership-insert attempt (which itself is idempotent via
    // ON CONFLICT(account_id, user_id) DO NOTHING).
    expect(insertMembershipSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when ON CONFLICT loses AND the re-SELECT comes back empty (defensive guard)', async () => {
    const { db } = makeDb({
      lookupRows: [],
      insertReturn: [],
      reSelectRows: [], // race winner deleted before re-SELECT — should never happen in practice
    });

    await expect(getOrCreateAtlasBotUser(db, TEST_ACCOUNT_ID)).rejects.toThrow(
      /atlas-bot user row missing/,
    );
  });
});
