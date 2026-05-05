import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '@blossom/db';
import {
  dispatchEmailSend,
  type SendEmailInput,
  type DispatchEmailDeps,
} from '../email-sender.js';

const buildInput = (): SendEmailInput => ({
  messageId: 'msg-1',
  conversationId: 'conv-1',
  inboxId: 'inbox-1',
  contactEmail: 'contact@example.com',
  subject: 'Test subject',
  text: 'hello',
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

const buildDeps = (overrides: Partial<DispatchEmailDeps> = {}): DispatchEmailDeps => ({
  db: {} as unknown as DB,
  log: buildLog(),
  sendPostmarkImpl: vi.fn().mockResolvedValue(undefined),
  sendGmailImpl: vi.fn().mockResolvedValue(undefined),
  getGmailAccessToken: vi.fn().mockResolvedValue('ya29.test-access-token'),
  ...overrides,
});

describe('dispatchEmailSend', () => {
  let deps: DispatchEmailDeps;

  beforeEach(() => {
    deps = buildDeps();
  });

  describe('Postmark routing', () => {
    it('routes provider: "postmark" → sendViaPostmark', async () => {
      const config = { provider: 'postmark', fromEmail: 'a@b.com', fromName: 'Acme' };
      const secrets = { serverToken: 'pm-tok' };
      const input = buildInput();

      await dispatchEmailSend(input, config, secrets, 'reply-id-1', deps);

      expect(deps.sendPostmarkImpl).toHaveBeenCalledTimes(1);
      expect(deps.sendPostmarkImpl).toHaveBeenCalledWith(
        input,
        expect.objectContaining({ fromEmail: 'a@b.com', fromName: 'Acme' }),
        expect.objectContaining({ serverToken: 'pm-tok' }),
        'reply-id-1',
        expect.objectContaining({ db: deps.db, log: deps.log }),
      );
    });

    it('routes legacy (no `provider` field) → sendViaPostmark', async () => {
      const config = { fromEmail: 'legacy@b.com' };
      const secrets = { serverToken: 'legacy-tok' };

      await dispatchEmailSend(buildInput(), config, secrets, null, deps);

      expect(deps.sendPostmarkImpl).toHaveBeenCalledTimes(1);
      expect(deps.sendPostmarkImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ fromEmail: 'legacy@b.com' }),
        expect.objectContaining({ serverToken: 'legacy-tok' }),
        null,
        expect.anything(),
      );
    });

    it('routes null/undefined config → sendViaPostmark (defensive)', async () => {
      await dispatchEmailSend(buildInput(), null, null, null, deps);
      expect(deps.sendPostmarkImpl).toHaveBeenCalledTimes(1);

      await dispatchEmailSend(buildInput(), undefined, undefined, null, deps);
      expect(deps.sendPostmarkImpl).toHaveBeenCalledTimes(2);
    });

    it('forwards inReplyToMessageId unchanged', async () => {
      await dispatchEmailSend(buildInput(), {}, {}, 'mid-xyz', deps);

      expect(deps.sendPostmarkImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'mid-xyz',
        expect.anything(),
      );
    });

    it('passes parsed (passthrough-preserved) config + secrets to the postmark impl', async () => {
      // EmailConfigSchema uses .passthrough() — extra fields must survive parse.
      const config = {
        provider: 'postmark',
        fromEmail: 'a@b.com',
        unknownExtra: 'kept',
      };
      const secrets = { serverToken: 'pm-tok', otherSecret: 'kept' };

      await dispatchEmailSend(buildInput(), config, secrets, null, deps);

      expect(deps.sendPostmarkImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ fromEmail: 'a@b.com', unknownExtra: 'kept' }),
        expect.objectContaining({ serverToken: 'pm-tok', otherSecret: 'kept' }),
        null,
        expect.anything(),
      );
    });

    it('does not pass `sendPostmarkImpl` itself to the postmark impl', async () => {
      // Deps leak guard — the test seam must not bleed into production callees.
      await dispatchEmailSend(buildInput(), {}, {}, null, deps);

      const mockFn = deps.sendPostmarkImpl as ReturnType<typeof vi.fn>;
      const firstCall = mockFn.mock.calls[0];
      expect(firstCall).toBeDefined();
      const callDeps = firstCall![4] as Record<string, unknown>;
      expect(callDeps).not.toHaveProperty('sendPostmarkImpl');
      expect(callDeps).toEqual({ db: deps.db, log: deps.log });
    });
  });

  describe('Gmail routing (T-48)', () => {
    it('routes provider: "gmail" → sendViaGmail', async () => {
      const config = {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        fromName: 'Acme',
      };
      const secrets = {
        refreshToken: '[REDACTED]',
        accessToken: '[REDACTED]',
        expiresAt: '2026-05-05T13:00:00.000Z',
      };
      const input = buildInput();

      await dispatchEmailSend(input, config, secrets, 'reply-id-1', deps);

      expect(deps.sendGmailImpl).toHaveBeenCalledTimes(1);
      expect(deps.sendPostmarkImpl).not.toHaveBeenCalled();
    });

    it('passes parsed Gmail config (provider + gmailEmail + fromName) to sendViaGmail', async () => {
      const config = {
        provider: 'gmail',
        gmailEmail: 'support@example.com',
        fromName: 'Acme',
        gmailHistoryId: '12345',
        needsReauth: false,
      };

      await dispatchEmailSend(buildInput(), config, {}, null, deps);

      expect(deps.sendGmailImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: 'gmail',
          gmailEmail: 'support@example.com',
          fromName: 'Acme',
          gmailHistoryId: '12345',
          needsReauth: false,
        }),
        null,
        null,
        expect.anything(),
      );
    });

    it('forwards inReplyToMessageId unchanged to sendViaGmail', async () => {
      await dispatchEmailSend(
        buildInput(),
        { provider: 'gmail', gmailEmail: 'a@b.com' },
        {},
        'mid-xyz',
        deps,
      );

      expect(deps.sendGmailImpl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'mid-xyz',
        null,
        expect.anything(),
      );
    });

    it('passes threadId = null (worker-side wiring is a follow-up)', async () => {
      // Spec § 7: `threadId` is optional in `users.messages.send` ("if present").
      // The dispatcher's API today does not carry a Gmail thread id (the
      // EmailOutboundJob shape predates Gmail). Wiring per-conversation
      // gmailThreadId from inbound metadata is a separate task — for now,
      // outbound replies still thread via In-Reply-To headers, which Gmail
      // honors even without a server-side threadId hint.
      await dispatchEmailSend(
        buildInput(),
        { provider: 'gmail', gmailEmail: 'a@b.com' },
        {},
        null,
        deps,
      );

      const mockFn = deps.sendGmailImpl as ReturnType<typeof vi.fn>;
      const call = mockFn.mock.calls[0];
      expect(call).toBeDefined();
      const threadIdArg = call![3];
      expect(threadIdArg).toBeNull();
    });

    it('forwards db, log, and getAccessToken into sendViaGmail deps; does not leak test seams', async () => {
      await dispatchEmailSend(
        buildInput(),
        { provider: 'gmail', gmailEmail: 'a@b.com' },
        {},
        null,
        deps,
      );

      const mockFn = deps.sendGmailImpl as ReturnType<typeof vi.fn>;
      const callDeps = mockFn.mock.calls[0]![4] as Record<string, unknown>;
      expect(callDeps).toHaveProperty('db', deps.db);
      expect(callDeps).toHaveProperty('log', deps.log);
      expect(callDeps).toHaveProperty('getAccessToken');
      expect(typeof callDeps.getAccessToken).toBe('function');
      // Test seams must not bleed into the production callee.
      expect(callDeps).not.toHaveProperty('sendGmailImpl');
      expect(callDeps).not.toHaveProperty('sendPostmarkImpl');
      expect(callDeps).not.toHaveProperty('getGmailAccessToken');
    });

    it('the forwarded getAccessToken delegates to deps.getGmailAccessToken', async () => {
      // Wiring proof: the closure passed to sendViaGmail.deps.getAccessToken
      // resolves to the dispatcher's getGmailAccessToken — that's what
      // production uses to drive `getValidAccessToken(app, inbox)`.
      await dispatchEmailSend(
        buildInput(),
        { provider: 'gmail', gmailEmail: 'a@b.com' },
        {},
        null,
        deps,
      );

      const mockFn = deps.sendGmailImpl as ReturnType<typeof vi.fn>;
      const callDeps = mockFn.mock.calls[0]![4] as { getAccessToken: () => Promise<string> };
      const token = await callDeps.getAccessToken();
      expect(token).toBe('ya29.test-access-token');
      expect(deps.getGmailAccessToken).toHaveBeenCalledTimes(1);
    });

    it('throws when provider is "gmail" but getGmailAccessToken is missing from deps', async () => {
      const depsWithoutAccessToken = buildDeps({ getGmailAccessToken: undefined });

      await expect(
        dispatchEmailSend(
          buildInput(),
          { provider: 'gmail', gmailEmail: 'a@b.com' },
          {},
          null,
          depsWithoutAccessToken,
        ),
      ).rejects.toThrow(/getGmailAccessToken/i);
      expect(depsWithoutAccessToken.sendGmailImpl).not.toHaveBeenCalled();
      expect(depsWithoutAccessToken.sendPostmarkImpl).not.toHaveBeenCalled();
    });

    it('does NOT call Postmark for gmail provider', async () => {
      await dispatchEmailSend(
        buildInput(),
        { provider: 'gmail', gmailEmail: 'a@b.com' },
        { refreshToken: '[REDACTED]' },
        null,
        deps,
      );

      expect(deps.sendPostmarkImpl).not.toHaveBeenCalled();
    });
  });

  describe('unknown provider', () => {
    it('falls back to Postmark for unrecognized provider strings', async () => {
      // Defensive: an unknown string (e.g. typo, future provider) must not silently
      // succeed nor crash; falling back to the legacy path keeps existing inboxes alive.
      const config = { provider: 'imap', fromEmail: 'a@b.com' };

      await dispatchEmailSend(buildInput(), config, { serverToken: 'tok' }, null, deps);

      expect(deps.sendPostmarkImpl).toHaveBeenCalledTimes(1);
    });

    it('non-string provider field treated as legacy (Postmark)', async () => {
      const config = { provider: 42, fromEmail: 'a@b.com' };

      await dispatchEmailSend(
        buildInput(),
        config as unknown,
        { serverToken: 'tok' },
        null,
        deps,
      );

      expect(deps.sendPostmarkImpl).toHaveBeenCalledTimes(1);
    });
  });
});
