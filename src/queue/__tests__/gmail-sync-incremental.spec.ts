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
  db: {
    update: ReturnType<typeof vi.fn>;
    updateSet: ReturnType<typeof vi.fn>;
    updateWhere: ReturnType<typeof vi.fn>;
  };
}

function buildApp(rows: unknown[]): AppStub {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    app: { db: { select, update }, log } as unknown as FastifyInstance,
    log,
    db: { update, updateSet, updateWhere },
  };
}

function buildHealthyInbox(
  overrides: Partial<{
    config: unknown;
    defaultBotId: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    id: INBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Test Gmail Inbox',
    channelType: 'email',
    config: { provider: 'gmail', gmailHistoryId: 'h-start' },
    secrets: 'v1:irrelevant:tokens-injected-via-mock',
    enabled: true,
    defaultBotId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildFullGmailMessage(
  id: string,
  overrides: {
    threadId?: string;
    historyId?: string;
    headers?: Array<{ name: string; value: string }>;
    bodyText?: string;
  } = {},
): Record<string, unknown> {
  const headers = overrides.headers ?? [
    { name: 'From', value: '"Alice Example" <alice@example.com>' },
    { name: 'Subject', value: 'Hi there' },
    { name: 'Message-ID', value: `<rfc-${id}@example.com>` },
  ];
  const bodyText = overrides.bodyText ?? `Body of ${id}`;
  return {
    id,
    threadId: overrides.threadId ?? 'thr-1',
    historyId: overrides.historyId ?? 'h-msg',
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: Buffer.from(bodyText).toString('base64url') },
    },
  };
}

interface HistoryListBody {
  history?: Array<{
    id: string;
    messagesAdded?: Array<{
      message: { id: string; threadId: string; labelIds?: string[] };
    }>;
  }>;
  historyId?: string;
  nextPageToken?: string;
}

function historyResponse(body: HistoryListBody): Response {
  return jsonResponse(body);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('processGmailSyncJob — incremental path', () => {
  it('hits users.history.list with the spec URL + Bearer when gmailHistoryId is stored', async () => {
    const inbox = buildHealthyInbox(); // gmailHistoryId: 'h-start'
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(historyResponse({ historyId: 'h-end' }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    // 1 history.list — no message-list, no message-gets, no getProfile.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(rawUrl as string);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/history',
    );
    expect(url.searchParams.get('startHistoryId')).toBe('h-start');
    expect(url.searchParams.get('historyTypes')).toBe('messageAdded');
    expect(url.searchParams.get('labelId')).toBe('INBOX');
    expect(url.searchParams.get('maxResults')).toBe('500');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.Accept).toBe('application/json');

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith(app, inbox);
  });

  it('does not hit the bootstrap users.messages.list endpoint when historyId is set', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(historyResponse({ historyId: 'h-end' }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    for (const call of fetchImpl.mock.calls) {
      const url = new URL(call[0] as string);
      expect(url.pathname).not.toContain('/users/me/messages');
      expect(url.pathname).not.toContain('/users/me/profile');
    }
  });

  it('fetches each messagesAdded id via messages.get?format=full and ingests in order', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({
          history: [
            {
              id: 'r-1',
              messagesAdded: [
                {
                  message: { id: 'gmail-id-aaa', threadId: 'thr-1' },
                },
              ],
            },
            {
              id: 'r-2',
              messagesAdded: [
                {
                  message: { id: 'gmail-id-bbb', threadId: 'thr-2' },
                },
              ],
            },
          ],
          historyId: 'h-after-incremental',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('gmail-id-aaa')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('gmail-id-bbb')));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 history + 2 gets

    const getUrls = fetchImpl.mock.calls.slice(1).map((c) => new URL(c[0] as string));
    expect(getUrls.map((u) => `${u.origin}${u.pathname}`)).toEqual([
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/gmail-id-aaa',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/gmail-id-bbb',
    ]);
    for (const u of getUrls) {
      expect(u.searchParams.get('format')).toBe('full');
    }

    expect(ingest).toHaveBeenCalledTimes(2);
    const ids = ingest.mock.calls.map(
      (c) =>
        (c[1] as { metadata: { gmailMessageId: string } }).metadata.gmailMessageId,
    );
    expect(ids).toEqual(['gmail-id-aaa', 'gmail-id-bbb']);
  });

  it('persists the response historyId into config.gmailHistoryId (cursor advances)', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({
          history: [
            {
              id: 'r-1',
              messagesAdded: [{ message: { id: 'm-1', threadId: 't' } }],
            },
          ],
          historyId: 'h-advanced',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('m-1')));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: Record<string, unknown>;
      updatedAt: Date;
    };
    expect(setArg.config.gmailHistoryId).toBe('h-advanced');
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it('preserves existing config fields when advancing the cursor', async () => {
    const inbox = buildHealthyInbox({
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        fromName: 'Support Team',
        needsReauth: false,
        gmailHistoryId: 'h-start',
      },
    });
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({ historyId: 'h-after' }),
      );
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: Record<string, unknown>;
    };
    expect(setArg.config).toEqual({
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      fromName: 'Support Team',
      needsReauth: false,
      gmailHistoryId: 'h-after',
    });
  });

  it('persists historyId even when history.list returns no records', async () => {
    // Empty incremental window is the steady state on a quiet inbox; the
    // cursor must still advance so we don't repeatedly read the same window.
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(historyResponse({ historyId: 'h-quiet' }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: { gmailHistoryId: string };
    };
    expect(setArg.config.gmailHistoryId).toBe('h-quiet');
  });

  it('dedupes a message id that appears in multiple history records', async () => {
    // Same message can appear in several messagesAdded events (label changes,
    // thread updates) — the worker must fetch + ingest it exactly once.
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({
          history: [
            {
              id: 'r-1',
              messagesAdded: [{ message: { id: 'dup', threadId: 't' } }],
            },
            {
              id: 'r-2',
              messagesAdded: [{ message: { id: 'dup', threadId: 't' } }],
            },
          ],
          historyId: 'h-end',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('dup')));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 history + 1 get
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('throws when history.list returns 5xx so BullMQ schedules a retry', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 503 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await expect(
      processGmailSyncJob(
        app,
        { data: { inboxId: INBOX_ID } },
        { fetchImpl, getAccessToken, ingest },
      ),
    ).rejects.toThrow(/history\.list 503/);
    expect(ingest).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws when history.list response is missing historyId so we never persist a partial cursor', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ history: [] })); // no historyId
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await expect(
      processGmailSyncJob(
        app,
        { data: { inboxId: INBOX_ID } },
        { fetchImpl, getAccessToken, ingest },
      ),
    ).rejects.toThrow(/historyId/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips ingest for a message with no parseable From header (logs + continues)', async () => {
    const inbox = buildHealthyInbox();
    const { app, log } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({
          history: [
            {
              id: 'r-1',
              messagesAdded: [
                { message: { id: 'broken', threadId: 't' } },
                { message: { id: 'ok', threadId: 't' } },
              ],
            },
          ],
          historyId: 'h-end',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(buildFullGmailMessage('broken', { headers: [] })),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('ok')));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(1);
    const payload = ingest.mock.calls[0]![1] as {
      metadata: { gmailMessageId: string };
    };
    expect(payload.metadata.gmailMessageId).toBe('ok');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID, gmailMessageId: 'broken' }),
      expect.stringMatching(/no From/i),
    );
  });

  it('does not abort the loop when ingest throws on one message', async () => {
    const inbox = buildHealthyInbox();
    const { app, log, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({
          history: [
            {
              id: 'r-1',
              messagesAdded: [
                { message: { id: 'fail', threadId: 't' } },
                { message: { id: 'next', threadId: 't' } },
              ],
            },
          ],
          historyId: 'h-after-failure',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('fail')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('next')));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ inboxId: INBOX_ID, gmailMessageId: 'fail' }),
      expect.stringMatching(/ingest/i),
    );
    // Cursor still advances even after an ingest failure (mirrors bootstrap).
    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: { gmailHistoryId: string };
    };
    expect(setArg.config.gmailHistoryId).toBe('h-after-failure');
  });

  it('on 404 from history.list, clears gmailHistoryId to force a bootstrap on next run', async () => {
    // Spec § 7 "Sync worker / Incremental path": 404 means the cursor expired
    // (Gmail discards history entries after ~7 days). Clear the cursor so the
    // next minute's run takes the bootstrap branch — do NOT throw, otherwise
    // BullMQ would retry forever against a permanently-404'ing endpoint.
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await expect(
      processGmailSyncJob(
        app,
        { data: { inboxId: INBOX_ID } },
        { fetchImpl, getAccessToken, ingest },
      ),
    ).resolves.toBeUndefined();

    expect(ingest).not.toHaveBeenCalled();
    // Only the history.list call — no message gets, no profile call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: { gmailHistoryId: string | null };
      updatedAt: Date;
    };
    expect(setArg.config.gmailHistoryId).toBeNull();
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it('on 404 from history.list, preserves other config fields when clearing the cursor', async () => {
    const inbox = buildHealthyInbox({
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        fromName: 'Support Team',
        needsReauth: false,
        gmailHistoryId: 'h-stale',
      },
    });
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: Record<string, unknown>;
    };
    expect(setArg.config).toEqual({
      provider: 'gmail',
      gmailEmail: 'support@example.com',
      fromName: 'Support Team',
      needsReauth: false,
      gmailHistoryId: null,
    });
  });

  it('on 404 from history.list, logs the expiry so operators can spot the bootstrap reset', async () => {
    const inbox = buildHealthyInbox();
    const { app, log } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    const allLogs = [...log.info.mock.calls, ...log.warn.mock.calls];
    const matched = allLogs.some(
      (call) =>
        typeof call[1] === 'string' &&
        /history.*(expired|reset|bootstrap)/i.test(call[1] as string),
    );
    expect(matched).toBe(true);
  });

  it('threads inbox.defaultBotId through to ingestWithHooks (4th argument)', async () => {
    const inbox = buildHealthyInbox({ defaultBotId: 'bot-123' });
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        historyResponse({
          history: [
            {
              id: 'r-1',
              messagesAdded: [{ message: { id: 'a', threadId: 't' } }],
            },
          ],
          historyId: 'h-end',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('a')));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![3]).toBe('bot-123');
  });
});
