import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { processGmailSyncJob } from '../workers/gmail-sync.js';

const INBOX_ID = '11111111-1111-1111-1111-111111111111';

interface AppStub {
  app: FastifyInstance;
  selectLimit: ReturnType<typeof vi.fn>;
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

/**
 * Build a Fastify-shaped stub whose `db.select().from().where().limit()` chain
 * resolves to `selectRows`. Returns the chain leaves so a test can assert call
 * counts on lookup, plus a captured `log` to verify the skip-reason is emitted.
 */
function buildApp(selectRows: unknown[]): AppStub {
  const selectLimit = vi.fn().mockResolvedValue(selectRows);
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const app = { db: { select }, log } as unknown as FastifyInstance;

  return { app, selectLimit, log };
}

function buildInbox(overrides: Partial<{
  id: string;
  deletedAt: Date | null;
  enabled: boolean;
  config: unknown;
}> = {}): Record<string, unknown> {
  return {
    id: INBOX_ID,
    accountId: '22222222-2222-2222-2222-222222222222',
    name: 'Test Gmail Inbox',
    channelType: 'email',
    config: { provider: 'gmail', needsReauth: false },
    secrets: null,
    enabled: true,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('processGmailSyncJob — skip guards', () => {
  it('skips silently when the inbox row is missing (defensive)', async () => {
    const { app, selectLimit, log } = buildApp([]);

    await expect(
      processGmailSyncJob(app, { data: { inboxId: INBOX_ID } }),
    ).resolves.toBeUndefined();

    expect(selectLimit).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('skips when inbox.deletedAt is set', async () => {
    const inbox = buildInbox({ deletedAt: new Date('2026-04-30T00:00:00.000Z') });
    const { app, log } = buildApp([inbox]);

    await processGmailSyncJob(app, { data: { inboxId: INBOX_ID } });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID }),
      expect.stringContaining('deleted'),
    );
  });

  it('skips when inbox.enabled is false', async () => {
    const inbox = buildInbox({ enabled: false });
    const { app, log } = buildApp([inbox]);

    await processGmailSyncJob(app, { data: { inboxId: INBOX_ID } });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID }),
      expect.stringContaining('disabled'),
    );
  });

  it("skips when config.provider is not 'gmail' (e.g. legacy postmark inbox)", async () => {
    const inbox = buildInbox({ config: { provider: 'postmark' } });
    const { app, log } = buildApp([inbox]);

    await processGmailSyncJob(app, { data: { inboxId: INBOX_ID } });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID }),
      expect.stringContaining('provider'),
    );
  });

  it('skips when config.provider is missing entirely (very old rows)', async () => {
    const inbox = buildInbox({ config: {} });
    const { app, log } = buildApp([inbox]);

    await processGmailSyncJob(app, { data: { inboxId: INBOX_ID } });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID }),
      expect.stringContaining('provider'),
    );
  });

  it('skips when config.needsReauth is true', async () => {
    const inbox = buildInbox({ config: { provider: 'gmail', needsReauth: true } });
    const { app, log } = buildApp([inbox]);

    await processGmailSyncJob(app, { data: { inboxId: INBOX_ID } });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID }),
      expect.stringContaining('Reauth'),
    );
  });

  it('calls db.select exactly once per job (no extra lookups in the skip path)', async () => {
    const inbox = buildInbox({ enabled: false });
    const { app, selectLimit } = buildApp([inbox]);

    await processGmailSyncJob(app, { data: { inboxId: INBOX_ID } });

    expect(selectLimit).toHaveBeenCalledTimes(1);
  });
});
