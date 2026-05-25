import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';
import type { ConnectorEvent } from '@atlas/connectors';

// The script imports `../config` at module load (parses env — unavailable in
// the test env). Mock it like build-connector-event.spec.
vi.mock('../../config', () => ({ config: { ATLAS_SOURCE_ACCOUNT_ID: 'acct-env-default' } }));

import { emitContactsBulk, parseArgs } from '../atlas-emit-contacts-bulk';

type Row = { id: string; createdAt: Date };
const row = (id: string, iso: string): Row => ({ id, createdAt: new Date(iso) });
const fakeBuild = (id: string) =>
  Promise.resolve({ event_id: `contact_${id}` } as unknown as ConnectorEvent);
const makeConnector = () => ({ emitDirect: vi.fn().mockResolvedValue(undefined) });

/** Mock the cursor walk: select→from→where→orderBy→limit, where limit() resolves
 * the next page in order. Captures the `where` condition so a test can assert a
 * filter (the account scope) is applied rather than a bare table scan. */
function makeWalkDb(pages: Row[][]) {
  let pageIdx = 0;
  const whereConds: unknown[] = [];
  const limit = vi.fn(async () => pages[pageIdx++] ?? []);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn((cond: unknown) => (whereConds.push(cond), { orderBy }));
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DB, whereConds, limit };
}

const base = { accountId: 'acct-1', dryRun: false, buildEvent: fakeBuild } as const;

describe('emitContactsBulk', () => {
  it('walks all pages, batch-POSTs each, stops on a short page', async () => {
    const { db, whereConds, limit } = makeWalkDb([
      [row('a', '2026-01-01'), row('b', '2026-01-02'), row('c', '2026-01-03')],
      [row('d', '2026-01-04'), row('e', '2026-01-05')], // short page → stop
    ]);
    const connector = makeConnector();
    const res = await emitContactsBulk({ ...base, db, connector, batchSize: 3 });

    expect(res).toEqual({ contacts: 5, pages: 2, queued: 5 });
    expect(connector.emitDirect).toHaveBeenCalledTimes(2);
    expect((connector.emitDirect.mock.calls[0]![0] as { events: unknown[] }).events).toHaveLength(3);
    expect((connector.emitDirect.mock.calls[1]![0] as { events: unknown[] }).events).toHaveLength(2);
    expect(limit).toHaveBeenCalledTimes(2); // short page ends the walk, no extra query
    expect(whereConds.every((c) => c != null)).toBe(true); // every page account-scoped
  });

  it('terminates on an exact-multiple total via a trailing empty query', async () => {
    const { db, limit } = makeWalkDb([
      [row('a', '2026-01-01'), row('b', '2026-01-02')],
      [row('c', '2026-01-03'), row('d', '2026-01-04')], // full page → keep going
      [], // empty → stop (guards against an infinite loop)
    ]);
    const connector = makeConnector();
    const res = await emitContactsBulk({ ...base, db, connector, batchSize: 2 });

    expect(res).toEqual({ contacts: 4, pages: 2, queued: 4 });
    expect(connector.emitDirect).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenCalledTimes(3); // two pages + the terminating empty query
  });

  it('dry-run builds but never POSTs (queued stays 0)', async () => {
    const { db } = makeWalkDb([[row('a', '2026-01-01'), row('b', '2026-01-02')]]);
    const connector = makeConnector();
    const buildEvent = vi.fn(fakeBuild);
    const res = await emitContactsBulk({ ...base, db, connector, batchSize: 2, dryRun: true, buildEvent });

    expect(res).toEqual({ contacts: 2, pages: 1, queued: 0 });
    expect(buildEvent).toHaveBeenCalledTimes(2);
    expect(connector.emitDirect).not.toHaveBeenCalled();
  });

  it('refuses to run without an account scope (anti-leak P0)', async () => {
    const { db } = makeWalkDb([[]]);
    await expect(
      emitContactsBulk({ ...base, db, connector: makeConnector(), accountId: '', batchSize: 500 }),
    ).rejects.toThrow(/anti-leak/i);
  });
});

describe('parseArgs', () => {
  it('parses flags, clamps batch to the SDK cap, defaults account to env', () => {
    expect(parseArgs(['--dry-run', '--batch=1500', '--account=acc-9'], 'env-default')).toEqual({
      dryRun: true,
      batchSize: 1000,
      account: 'acc-9',
    });
    expect(parseArgs([], 'env-default')).toEqual({ dryRun: false, batchSize: 500, account: 'env-default' });
  });
});
