import type { FastifyBaseLogger } from 'fastify';
import { schema, type DB } from '@blossom/db';
import { describe, expect, it, vi } from 'vitest';
import {
  composeMimeRfc5322,
  sendViaGmail,
  type SendGmailDeps,
} from '../gmail-sender.js';
import type { SendEmailInput } from '../email-sender.js';

const ACCESS_TOKEN = 'ya29.test-access-token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

const buildInput = (overrides: Partial<SendEmailInput> = {}): SendEmailInput => ({
  messageId: '11111111-1111-1111-1111-111111111111',
  conversationId: '22222222-2222-2222-2222-222222222222',
  inboxId: '33333333-3333-3333-3333-333333333333',
  contactEmail: 'customer@acme.com',
  subject: 'Welcome',
  text: 'Hello there',
  ...overrides,
});

const buildLog = (): FastifyBaseLogger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  }) as unknown as FastifyBaseLogger;

interface DbStub {
  db: DB;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateSet: ReturnType<typeof vi.fn>;
  updateWhere: ReturnType<typeof vi.fn>;
}

/**
 * Builds a Drizzle-shaped stub. `select().from().where().limit()` resolves to
 * `selectRows`; `update().set(payload).where()` captures the patch.
 */
function buildDb(selectRows: unknown[] = [{ deliveredAt: null, failedAt: null }]): DbStub {
  const limit = vi.fn().mockResolvedValue(selectRows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return {
    db: { select, update } as unknown as DB,
    select,
    update,
    updateSet,
    updateWhere,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildDeps(
  overrides: Partial<SendGmailDeps> & { selectRows?: unknown[] } = {},
): { deps: SendGmailDeps; dbStub: DbStub; getAccessToken: ReturnType<typeof vi.fn>; fetchImpl: ReturnType<typeof vi.fn> } {
  const dbStub = overrides.selectRows ? buildDb(overrides.selectRows) : buildDb();
  const getAccessToken =
    (overrides.getAccessToken as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn().mockResolvedValue(ACCESS_TOKEN);
  const fetchImpl =
    (overrides.fetchImpl as ReturnType<typeof vi.fn> | undefined) ??
    vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'gmail-msg-id-123', threadId: 'thr-1', labelIds: ['SENT'] }),
      );
  return {
    deps: {
      db: overrides.db ?? dbStub.db,
      log: overrides.log ?? buildLog(),
      getAccessToken,
      fetchImpl,
    },
    dbStub,
    getAccessToken,
    fetchImpl,
  };
}

describe('composeMimeRfc5322', () => {
  describe('basic structure', () => {
    it('separates headers from body with a blank CRLF line', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hello',
      });
      expect(mime.endsWith('\r\n\r\nhello')).toBe(true);
    });

    it('uses CRLF line endings on every header (no bare LFs)', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hello',
      });
      const headers = mime.split('\r\n\r\n')[0]!;
      // No header line begins or ends without CRLF — every internal newline is CRLF.
      expect(headers).not.toMatch(/[^\r]\n/);
    });

    it('declares MIME-Version 1.0 and UTF-8 plain text content type', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hello',
      });
      expect(mime).toContain('MIME-Version: 1.0\r\n');
      expect(mime).toContain('Content-Type: text/plain; charset=UTF-8\r\n');
    });

    it('renders From, To, Subject with the supplied values', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com' },
        to: 'customer@acme.com',
        subject: 'Welcome',
        body: 'hi',
      });
      expect(mime).toContain('From: agent@axis.com\r\n');
      expect(mime).toContain('To: customer@acme.com\r\n');
      expect(mime).toContain('Subject: Welcome\r\n');
    });
  });

  describe('UTF-8 plain text body', () => {
    it('preserves non-ASCII characters in the body verbatim', () => {
      const body = 'Olá! Aqui está o relatório com café ☕';
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Test',
        body,
      });
      expect(mime).toContain(body);
    });

    it('preserves multi-line bodies with CR/LF intact', () => {
      const body = 'line one\nline two\n\nparagraph two';
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Test',
        body,
      });
      // Body comes after the blank-line separator, untouched.
      expect(mime.split('\r\n\r\n')[1]).toBe(body);
    });
  });

  describe('From — display name quoting', () => {
    it('wraps display name in double quotes when name is present', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com', name: 'Atendimento Acme' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Atendimento Acme" <agent@axis.com>\r\n');
    });

    it('escapes embedded double quotes via quoted-pair (\\")', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'boss@example.com', name: 'Smith "The Boss"' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Smith \\"The Boss\\"" <boss@example.com>\r\n');
    });

    it('escapes embedded backslashes via quoted-pair (\\\\)', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com', name: 'Smith\\Co' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Smith\\\\Co" <agent@axis.com>\r\n');
    });

    it('keeps RFC 5322 specials (comma, parens) inside the quoted display name', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com', name: 'Doe, John (acct)' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: "Doe, John (acct)" <a@b.com>\r\n');
    });

    it('emits a bare address when name is missing', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: agent@axis.com\r\n');
      expect(mime).not.toContain('From: "');
    });

    it('emits a bare address when name is an empty string', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'agent@axis.com', name: '' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).toContain('From: agent@axis.com\r\n');
      expect(mime).not.toContain('From: ""');
    });
  });

  describe('Threading hints', () => {
    it('omits In-Reply-To and References when no hints provided', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
      });
      expect(mime).not.toMatch(/^In-Reply-To:/m);
      expect(mime).not.toMatch(/^References:/m);
    });

    it('omits both headers when threadingHints is an empty object', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: {},
      });
      expect(mime).not.toMatch(/^In-Reply-To:/m);
      expect(mime).not.toMatch(/^References:/m);
    });

    it('emits In-Reply-To when only inReplyTo is set', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: { inReplyTo: '<parent@gmail.com>' },
      });
      expect(mime).toContain('In-Reply-To: <parent@gmail.com>\r\n');
      expect(mime).not.toMatch(/^References:/m);
    });

    it('emits References when only references is set', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: { references: '<root@x> <parent@x>' },
      });
      expect(mime).toContain('References: <root@x> <parent@x>\r\n');
      expect(mime).not.toMatch(/^In-Reply-To:/m);
    });

    it('emits BOTH In-Reply-To and References when both hints provided', () => {
      const mime = composeMimeRfc5322({
        from: { email: 'a@b.com' },
        to: 'c@d.com',
        subject: 'Hi',
        body: 'hi',
        threadingHints: {
          inReplyTo: '<parent@gmail.com>',
          references: '<root@gmail.com> <parent@gmail.com>',
        },
      });
      expect(mime).toContain('In-Reply-To: <parent@gmail.com>\r\n');
      expect(mime).toContain(
        'References: <root@gmail.com> <parent@gmail.com>\r\n',
      );
    });
  });
});

describe('sendViaGmail — happy path (T-45)', () => {
  it('POSTs to users.messages.send with Bearer token + JSON content-type', async () => {
    const { deps, fetchImpl, getAccessToken } = buildDeps();
    const input = buildInput();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(input, config, null, null, deps);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(SEND_URL);
    const initObj = init as RequestInit;
    expect(initObj.method).toBe('POST');
    const headers = initObj.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');
  });

  it('uses AbortSignal.timeout (15s) on the outbound request', async () => {
    const { deps, fetchImpl } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };
    await sendViaGmail(buildInput(), config, null, null, deps);
    const initObj = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(initObj.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes the MIME body as base64url under `raw` in the request body', async () => {
    const { deps, fetchImpl } = buildDeps();
    const input = buildInput({
      contactEmail: 'customer@acme.com',
      subject: 'Hello',
      text: 'Hi customer',
    });
    const config = {
      provider: 'gmail' as const,
      gmailEmail: 'support@example.com',
      fromName: 'Atendimento Acme',
    };

    await sendViaGmail(input, config, null, null, deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string };
    expect(typeof body.raw).toBe('string');
    // base64url alphabet: A-Z a-z 0-9 - _ (no =, no +/  )
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('From: "Atendimento Acme" <support@example.com>\r\n');
    expect(decoded).toContain('To: customer@acme.com\r\n');
    expect(decoded).toContain('Subject: Hello\r\n');
    expect(decoded).toContain('\r\n\r\nHi customer');
  });

  it('emits bare From address when fromName is absent', async () => {
    const { deps, fetchImpl } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, null, null, deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('From: support@example.com\r\n');
    expect(decoded).not.toContain('From: "');
  });

  it('includes In-Reply-To and References MIME headers when inReplyToMessageId provided', async () => {
    const { deps, fetchImpl } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, '<parent-rfc-id@gmail.com>', null, deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('In-Reply-To: <parent-rfc-id@gmail.com>\r\n');
    expect(decoded).toContain('References: <parent-rfc-id@gmail.com>\r\n');
  });

  it('omits In-Reply-To and References MIME headers when inReplyToMessageId is null', async () => {
    const { deps, fetchImpl } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, null, null, deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).not.toMatch(/^In-Reply-To:/m);
    expect(decoded).not.toMatch(/^References:/m);
  });

  it('includes `threadId` in the request body when provided', async () => {
    const { deps, fetchImpl } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, null, 'thr-abc-123', deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string; threadId?: string };
    expect(body.threadId).toBe('thr-abc-123');
  });

  it('omits `threadId` from the request body when null', async () => {
    const { deps, fetchImpl } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, null, null, deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string; threadId?: string };
    expect(body).not.toHaveProperty('threadId');
  });

  it('on 200, updates the message row with deliveredAt + channelMsgId from response.id', async () => {
    const { deps, dbStub, fetchImpl } = buildDeps();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ id: 'gmail-msg-id-RESP', threadId: 'thr-1', labelIds: ['SENT'] }),
    );
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, null, null, deps);

    expect(dbStub.update).toHaveBeenCalledTimes(1);
    expect(dbStub.updateSet).toHaveBeenCalledTimes(1);
    const patch = dbStub.updateSet.mock.calls[0]![0] as {
      channelMsgId?: string | null;
      deliveredAt?: Date;
    };
    expect(patch.channelMsgId).toBe('gmail-msg-id-RESP');
    expect(patch.deliveredAt).toBeInstanceOf(Date);
  });

  it('selects the existing message row by id BEFORE sending (idempotency pre-check)', async () => {
    const { deps, dbStub } = buildDeps();
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(buildInput(), config, null, null, deps);

    // The pre-check is the same shape Postmark uses — select before fetch.
    expect(dbStub.select).toHaveBeenCalledTimes(1);
  });

  it('preserves UTF-8 body bytes through base64url round-trip', async () => {
    const { deps, fetchImpl } = buildDeps();
    const text = 'Olá! relatório com café ☕';
    const input = buildInput({ text });
    const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

    await sendViaGmail(input, config, null, null, deps);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain(text);
  });
});

describe('sendViaGmail — error handling (T-46)', () => {
  describe('401 Unauthorized → reauth + permanent fail', () => {
    it('patches inboxes.config setting needsReauth: true (preserving other fields)', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } },
          401,
        ),
      );
      const config = {
        provider: 'gmail' as const,
        gmailEmail: 'support@example.com',
        gmailHistoryId: '987654321',
        fromName: 'Atendimento Acme',
      };

      await sendViaGmail(buildInput(), config, null, null, deps);

      // Two updates: inbox config first, then message failure-mark.
      expect(dbStub.update).toHaveBeenCalledTimes(2);
      expect(dbStub.update).toHaveBeenNthCalledWith(1, schema.inboxes);
      expect(dbStub.update).toHaveBeenNthCalledWith(2, schema.messages);

      const inboxPatch = dbStub.updateSet.mock.calls[0]![0] as {
        config?: {
          needsReauth?: boolean;
          provider?: string;
          gmailEmail?: string;
          gmailHistoryId?: string;
          fromName?: string;
        };
      };
      expect(inboxPatch.config?.needsReauth).toBe(true);
      // Other config fields survive the patch.
      expect(inboxPatch.config?.provider).toBe('gmail');
      expect(inboxPatch.config?.gmailEmail).toBe('support@example.com');
      expect(inboxPatch.config?.gmailHistoryId).toBe('987654321');
      expect(inboxPatch.config?.fromName).toBe('Atendimento Acme');
    });

    it('marks the message failedAt with reason "gmail oauth expired — reauthorize"', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 401, message: 'Invalid Credentials' } }, 401),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await sendViaGmail(buildInput(), config, null, null, deps);

      const messagePatch = dbStub.updateSet.mock.calls[1]![0] as {
        failedAt?: Date;
        failureReason?: string;
      };
      expect(messagePatch.failedAt).toBeInstanceOf(Date);
      expect(messagePatch.failureReason).toBe('gmail oauth expired — reauthorize');
    });

    it('does NOT throw — permanent fail, no BullMQ retry', async () => {
      const { deps, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 401, message: 'Invalid Credentials' } }, 401),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await expect(
        sendViaGmail(buildInput(), config, null, null, deps),
      ).resolves.toBeUndefined();
    });

    it('does NOT set deliveredAt or channelMsgId on a 401', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 401, message: 'Invalid Credentials' } }, 401),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await sendViaGmail(buildInput(), config, null, null, deps);

      // Neither update payload should look like a delivery success.
      for (const call of dbStub.updateSet.mock.calls) {
        const patch = call[0] as { deliveredAt?: Date; channelMsgId?: string | null };
        expect(patch.deliveredAt).toBeUndefined();
        expect(patch.channelMsgId).toBeUndefined();
      }
    });
  });

  describe('4xx other → permanent fail (no reauth)', () => {
    it('400: marks message failedAt with the Gmail error message', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 400, message: 'Invalid To header', status: 'INVALID_ARGUMENT' } },
          400,
        ),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await sendViaGmail(buildInput(), config, null, null, deps);

      // Single update: message only — inboxes is NOT touched.
      expect(dbStub.update).toHaveBeenCalledTimes(1);
      expect(dbStub.update).toHaveBeenNthCalledWith(1, schema.messages);
      const patch = dbStub.updateSet.mock.calls[0]![0] as {
        failedAt?: Date;
        failureReason?: string;
      };
      expect(patch.failedAt).toBeInstanceOf(Date);
      expect(patch.failureReason).toBe('Invalid To header');
    });

    it('400: falls back to "gmail 400" when the response body has no message', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(new Response('', { status: 400 }));
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await sendViaGmail(buildInput(), config, null, null, deps);

      const patch = dbStub.updateSet.mock.calls[0]![0] as { failureReason?: string };
      expect(patch.failureReason).toBe('gmail 400');
    });

    it('does NOT throw on 400 — permanent fail', async () => {
      const { deps, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 400, message: 'Bad' } }, 400),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await expect(
        sendViaGmail(buildInput(), config, null, null, deps),
      ).resolves.toBeUndefined();
    });

    it('does NOT touch inboxes.config on 400 (no reauth flag)', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 400, message: 'Bad' } }, 400),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await sendViaGmail(buildInput(), config, null, null, deps);

      // Only one update — to schema.messages, never schema.inboxes.
      expect(dbStub.update).toHaveBeenCalledTimes(1);
      expect(dbStub.update.mock.calls[0]![0]).toBe(schema.messages);
    });

    it('404: also treated as permanent fail with "gmail 404" reason', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(new Response('', { status: 404 }));
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await sendViaGmail(buildInput(), config, null, null, deps);

      expect(dbStub.update).toHaveBeenCalledTimes(1);
      expect(dbStub.update.mock.calls[0]![0]).toBe(schema.messages);
      const patch = dbStub.updateSet.mock.calls[0]![0] as { failureReason?: string };
      expect(patch.failureReason).toBe('gmail 404');
    });
  });

  describe('5xx → throw (BullMQ retries)', () => {
    it('503: throws with "gmail 503" so BullMQ retries', async () => {
      const { deps, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 503, message: 'Backend Error' } }, 503),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await expect(
        sendViaGmail(buildInput(), config, null, null, deps),
      ).rejects.toThrow(/gmail 503/);
    });

    it('503: makes NO DB writes (no failedAt, no needsReauth)', async () => {
      const { deps, dbStub, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 503, message: 'Backend Error' } }, 503),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await expect(
        sendViaGmail(buildInput(), config, null, null, deps),
      ).rejects.toThrow();
      // Pre-check select runs, but no failure-mark or reauth update should fire.
      expect(dbStub.update).not.toHaveBeenCalled();
    });

    it('500: throws with "gmail 500"', async () => {
      const { deps, fetchImpl } = buildDeps();
      fetchImpl.mockResolvedValueOnce(
        jsonResponse({ error: { code: 500, message: 'Internal' } }, 500),
      );
      const config = { provider: 'gmail' as const, gmailEmail: 'support@example.com' };

      await expect(
        sendViaGmail(buildInput(), config, null, null, deps),
      ).rejects.toThrow(/gmail 500/);
    });
  });
});
