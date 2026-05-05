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

/**
 * Fastify-shaped stub whose `db.select().from().where().limit()` chain resolves
 * to the rows we want the worker to see, and whose `db.update().set().where()`
 * chain resolves cleanly. T-36 introduced the update path (persisting
 * `gmailHistoryId` after a successful bootstrap run); the chain captures call
 * args so tests can assert on the patched `config` payload.
 */
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
  overrides: Partial<{ config: unknown; defaultBotId: string | null }> = {},
): Record<string, unknown> {
  return {
    id: INBOX_ID,
    accountId: ACCOUNT_ID,
    name: 'Test Gmail Inbox',
    channelType: 'email',
    config: { provider: 'gmail' },
    secrets: 'v1:irrelevant:tokens-injected-via-mock',
    enabled: true,
    defaultBotId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Builds a Gmail messages.get response body shaped like `format=full`. Headers
 * default to a minimal set with a parseable `From` so ingest fires; callers can
 * override or pass `[]` to simulate a malformed message.
 */
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
    { name: 'Message-ID', value: '<rfc-msg-id-1@example.com>' },
    { name: 'In-Reply-To', value: '<parent-1@example.com>' },
  ];
  const bodyText = overrides.bodyText ?? 'Hello world';
  return {
    id,
    threadId: overrides.threadId ?? 'thr-1',
    historyId: overrides.historyId ?? 'h-100',
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: Buffer.from(bodyText).toString('base64url') },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * T-36: every successful bootstrap ends with a `users.getProfile` call so the
 * worker can persist `gmailHistoryId`. Tests that don't care about the profile
 * step queue this catch-all default to keep the chain valid.
 */
function profileResponse(historyId = 'h-from-profile'): Response {
  return jsonResponse({
    emailAddress: 'support@example.com',
    historyId,
    messagesTotal: 0,
    threadsTotal: 0,
  });
}

describe('processGmailSyncJob — bootstrap path', () => {
  it('hits users.messages.list with the spec URL + Bearer when no gmailHistoryId is stored', async () => {
    const inbox = buildHealthyInbox(); // config has provider: 'gmail', no historyId
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    // 1 list + 1 getProfile (T-36 end-of-bootstrap persist).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('msg-aaa')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('msg-bbb')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('msg-ccc')))
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(5); // 1 list + 3 gets + 1 getProfile

    const getCalls = fetchImpl.mock.calls.slice(1, 4);
    const getUrls = getCalls.map((c) => new URL(c[0] as string));
    expect(getUrls.map((u) => `${u.origin}${u.pathname}`)).toEqual([
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-aaa',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-bbb',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-ccc',
    ]);
    for (const u of getUrls) {
      expect(u.searchParams.get('format')).toBe('full');
    }
    // Bearer header carries through to every Gmail call (including getProfile).
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
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    // 1 list + 1 getProfile (T-36 persists historyId even on empty bootstrap).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not run bootstrap when gmailHistoryId is already stored (incremental path is T-37+)', async () => {
    // T-34 covers ONLY the bootstrap branch. When `gmailHistoryId` is set the
    // worker falls through without making any Gmail call yet — T-37 will
    // replace this branch with `users.history.list` (incremental).
    const inbox = buildHealthyInbox({
      config: { provider: 'gmail', gmailHistoryId: '987654321' },
    });
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi.fn();
    const getAccessToken = vi.fn();
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    // Skipped path: no historyId update fires either (T-36 guard).
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws when messages.list returns 4xx so BullMQ schedules a retry', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('forbidden', { status: 403 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await expect(
      processGmailSyncJob(
        app,
        { data: { inboxId: INBOX_ID } },
        { fetchImpl, getAccessToken, ingest },
      ),
    ).rejects.toThrow(/messages\.list 403/);
    expect(ingest).not.toHaveBeenCalled();
    // List failed before getProfile could fire → no historyId persisted.
    expect(db.update).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce(jsonResponse({ id: 'msg/with slash' }))
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    const getUrl = fetchImpl.mock.calls[1]![0] as string;
    expect(getUrl).toContain('msg%2Fwith%20slash');
  });
});

describe('processGmailSyncJob — bootstrap path → ingest', () => {
  it('feeds each fetched message into ingestWithHooks with the parsed IncomingMessage payload', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [{ id: 'gmail-id-aaa', threadId: 'thr-1' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          buildFullGmailMessage('gmail-id-aaa', {
            threadId: 'thr-1',
            historyId: 'h-100',
          }),
        ),
      )
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({
      deduped: false,
      blocked: false,
      conversationId: 'c1',
      messageId: 'm1',
      contactId: 'k1',
    });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(1);
    const [appArg, payload, configArg, defaultBotIdArg] =
      ingest.mock.calls[0]!;
    expect(appArg).toBe(app);
    expect(configArg).toEqual({ provider: 'gmail' });
    expect(defaultBotIdArg).toBeNull();

    const expected = {
      inboxId: INBOX_ID,
      channel: 'email',
      content: 'Hello world',
      contentType: 'text',
      channelMsgId: '<rfc-msg-id-1@example.com>',
      threadHints: ['<parent-1@example.com>'],
      from: {
        identifier: 'alice@example.com',
        email: 'alice@example.com',
        name: 'Alice Example',
        metadata: {},
      },
      metadata: {
        subject: 'Hi there',
        gmailMessageId: 'gmail-id-aaa',
        gmailThreadId: 'thr-1',
        gmailHistoryId: 'h-100',
      },
    };
    expect(payload).toEqual(expected);
  });

  it('ingests every well-formed message in order across a 3-message bootstrap', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            { id: 'a', threadId: 't-a' },
            { id: 'b', threadId: 't-b' },
            { id: 'c', threadId: 't-c' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('a')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('b')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('c')))
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(3);
    const ids = ingest.mock.calls.map(
      (c) => (c[1] as { metadata: { gmailMessageId: string } }).metadata.gmailMessageId,
    );
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('preserves dedup contract: re-running with the same channelMsgId returns deduped without breaking the loop', async () => {
    // The worker only forwards to ingest; dedup itself lives in ingestWithHooks.
    // Asserts that a `deduped: true` result is acceptable (no throw) and the
    // next message in the batch is still ingested.
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            { id: 'old', threadId: 't' },
            { id: 'new', threadId: 't' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('old')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('new')))
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi
      .fn()
      .mockResolvedValueOnce({ deduped: true, blocked: false })
      .mockResolvedValueOnce({ deduped: false, blocked: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it('falls back to the Gmail message id as channelMsgId when Message-ID header is absent', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'gmail-id-zzz', threadId: 't' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          buildFullGmailMessage('gmail-id-zzz', {
            headers: [{ name: 'From', value: 'alice@example.com' }],
          }),
        ),
      )
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(1);
    const payload = ingest.mock.calls[0]![1] as { channelMsgId: string };
    expect(payload.channelMsgId).toBe('gmail-id-zzz');
  });

  it('skips ingest for a message with no parseable From header (logs + continues)', async () => {
    const inbox = buildHealthyInbox();
    const { app, log } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            { id: 'broken', threadId: 't' },
            { id: 'ok', threadId: 't' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        // No From header → parseGmailMessage returns from: undefined.
        jsonResponse(buildFullGmailMessage('broken', { headers: [] })),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('ok')))
      .mockResolvedValueOnce(profileResponse());
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
    const { app, log } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            { id: 'fail', threadId: 't' },
            { id: 'next', threadId: 't' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('fail')))
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('next')))
      .mockResolvedValueOnce(profileResponse());
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
  });

  it('falls back to "(sem conteúdo)" when both text/plain and text/html bodies are missing', async () => {
    // Mirrors the email-webhook fallback so the inbox UI has something to render.
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'empty', threadId: 't' }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'empty',
          threadId: 't',
          payload: {
            headers: [{ name: 'From', value: 'alice@example.com' }],
            // No body at all (multipart with no usable parts).
          },
        }),
      )
      .mockResolvedValueOnce(profileResponse());
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).toHaveBeenCalledTimes(1);
    const payload = ingest.mock.calls[0]![1] as { content: string };
    expect(payload.content).toBe('(sem conteúdo)');
  });

  it('threads inbox.defaultBotId through to ingestWithHooks (4th argument)', async () => {
    const inbox = buildHealthyInbox({ defaultBotId: 'bot-123' });
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'a', threadId: 't' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('a')))
      .mockResolvedValueOnce(profileResponse());
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

describe('processGmailSyncJob — bootstrap path → persist gmailHistoryId (T-36)', () => {
  it('calls users.getProfile with Bearer auth at the end of a successful bootstrap', async () => {
    const inbox = buildHealthyInbox();
    const { app } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'm-1', threadId: 't' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('m-1')))
      .mockResolvedValueOnce(profileResponse('h-from-profile'));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockResolvedValue({ deduped: false });

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3); // list + get + profile
    const profileCall = fetchImpl.mock.calls[2]!;
    const profileUrl = new URL(profileCall[0] as string);
    expect(`${profileUrl.origin}${profileUrl.pathname}`).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    );
    const profileHeaders = (profileCall[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(profileHeaders.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(profileHeaders.Accept).toBe('application/json');
  });

  it('persists historyId from the getProfile response into config.gmailHistoryId', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(profileResponse('h-12345'));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.updateSet).toHaveBeenCalledTimes(1);
    expect(db.updateWhere).toHaveBeenCalledTimes(1);

    const setArg = db.updateSet.mock.calls[0]![0] as {
      config: Record<string, unknown>;
      updatedAt: Date;
    };
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    expect(setArg.config.gmailHistoryId).toBe('h-12345');
  });

  it('preserves existing config fields alongside the new gmailHistoryId', async () => {
    const inbox = buildHealthyInbox({
      config: {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        fromName: 'Support Team',
        needsReauth: false,
      },
    });
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(profileResponse('h-77'));
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
      gmailHistoryId: 'h-77',
    });
  });

  it('persists historyId even when the bootstrap list is empty', async () => {
    // Spec § "Sync worker / Bootstrap path": "After all ingest, call
    // users.getProfile and store historyId" — fires even with zero messages.
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(profileResponse('h-99'));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(ingest).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(
      (db.updateSet.mock.calls[0]![0] as { config: { gmailHistoryId: string } })
        .config.gmailHistoryId,
    ).toBe('h-99');
  });

  it('still persists historyId when an ingest call throws (per-message failures do not block the cursor)', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ messages: [{ id: 'fail', threadId: 't' }] }),
      )
      .mockResolvedValueOnce(jsonResponse(buildFullGmailMessage('fail')))
      .mockResolvedValueOnce(profileResponse('h-after-failure'));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn().mockRejectedValue(new Error('db down'));

    await processGmailSyncJob(
      app,
      { data: { inboxId: INBOX_ID } },
      { fetchImpl, getAccessToken, ingest },
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(
      (db.updateSet.mock.calls[0]![0] as { config: { gmailHistoryId: string } })
        .config.gmailHistoryId,
    ).toBe('h-after-failure');
  });

  it('throws when getProfile returns non-2xx so BullMQ retries and no DB write happens', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    const ingest = vi.fn();

    await expect(
      processGmailSyncJob(
        app,
        { data: { inboxId: INBOX_ID } },
        { fetchImpl, getAccessToken, ingest },
      ),
    ).rejects.toThrow(/getProfile 503/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws when getProfile body is missing historyId so we never persist a partial cursor', async () => {
    const inbox = buildHealthyInbox();
    const { app, db } = buildApp([inbox]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ resultSizeEstimate: 0 }))
      .mockResolvedValueOnce(
        jsonResponse({ emailAddress: 'support@example.com' }),
      );
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
});
