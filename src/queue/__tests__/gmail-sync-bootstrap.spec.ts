import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { processGmailSyncJob } from '../workers/gmail-sync.js';

const INBOX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const ACCESS_TOKEN = 'ya29.test-token';

interface AppStub {
  app: FastifyInstance;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/**
 * Fastify-shaped stub whose `db.select().from().where().limit()` chain resolves
 * to the rows we want the worker to see. Only the select chain is stubbed —
 * T-34 does not write to the DB (T-36 will, when persisting `gmailHistoryId`).
 */
function buildApp(rows: unknown[]): AppStub {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    app: { db: { select }, log } as unknown as FastifyInstance,
    log,
  };
}

function buildHealthyInbox(
  overrides: Partial<{ config: unknown }> = {},
): Record<string, unknown> {
  return {
    id: INBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Test Gmail Inbox',
    channelType: 'email',
    config: { provider: 'gmail' },
    secrets: 'v1:irrelevant:tokens-injected-via-mock',
    enabled: true,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('processGmailSyncJob — bootstrap path', () => {
  it('hits users.messages.list with the spec URL + Bearer when no gmailHistoryId is stored', async () => {
    const inbox = buildHealthyInbox(); // config has provider: 'gmail', no historyId
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resultSizeEstimate: 0 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(rawUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
    );
    expect(url.searchParams.get('q')).toBe('is:unread newer_than:7d');
    expect(url.searchParams.get('labelIds')).toBe('INBOX');
    expect(url.searchParams.get('maxResults')).toBe('50');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.Accept).toBe('application/json');

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith(app, inbox);
  });

  it('fetches each listed message via messages.get?format=full', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            { id: 'msg-aaa', threadId: 'thr-1' },
            { id: 'msg-bbb', threadId: 'thr-2' },
            { id: 'msg-ccc', threadId: 'thr-3' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-aaa', payload: {} }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-bbb', payload: {} }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-ccc', payload: {} }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 list + 3 per-message gets

    const getCalls = fetchImpl.mock.calls.slice(1);
    const getUrls = getCalls.map((c) => new URL(c[0] as string));
    expect(getUrls.map((u) => `${u.origin}${u.pathname}`)).toEqual([
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-aaa',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-bbb',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-ccc',
    ]);
    for (const u of getUrls) {
      expect(u.searchParams.get('format')).toBe('full');
    }
    // Bearer header carries through to every per-message GET as well.
    for (const call of fetchImpl.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    }
  });

  it('makes no per-message get calls when the list comes back empty', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ resultSizeEstimate: 0 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1); // list only
  });

  it('does not run bootstrap when gmailHistoryId is already stored (incremental path is T-37+)', async () => {
    // T-34 covers ONLY the bootstrap branch. When `gmailHistoryId` is set the
    // worker falls through without making any Gmail call yet — T-37 will
    // replace this branch with `users.history.list` (incremental).
    const inbox = buildHealthyInbox({
      config: { provider: 'gmail', gmailHistoryId: '987654321' },
    });
    const { app } = buildApp([inbox]);
    const fetchImpl = vi.fn();
    const getAccessToken = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('throws when messages.list returns 4xx so BullMQ schedules a retry', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('forbidden', { status: 403 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);

    await expect(
      processGmailSyncJob(
        app,
        { data: { inboxId: INBOX_ID } },
        { fetchImpl, getAccessToken },
      ),
    ).rejects.toThrow(/messages\.list 403/);
  });

  it('encodes special characters in the message id when calling messages.get', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [{ id: 'msg/with slash', threadId: 'thr-1' }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'msg/with slash' }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken },
    );

    const getUrl = fetchImpl.mock.calls[1]![0] as string;
    expect(getUrl).toContain('msg%2Fwith%20slash');
  });
});
