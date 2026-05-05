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

  describe('Gmail routing (T-43: not yet implemented)', () => {
    it('throws "not implemented" for provider: "gmail"', async () => {
      const config = { provider: 'gmail', gmailEmail: 'support@example.com' };
      const secrets = {
        refreshToken: '[REDACTED]',
        accessToken: '[REDACTED]',
        expiresAt: '2026-05-05T13:00:00.000Z',
      };

      await expect(
        dispatchEmailSend(buildInput(), config, secrets, null, deps),
      ).rejects.toThrow(/not implemented/i);
      expect(deps.sendPostmarkImpl).not.toHaveBeenCalled();
    });

    it('mentions "gmail" in the not-implemented error message (debuggability)', async () => {
      await expect(
        dispatchEmailSend(buildInput(), { provider: 'gmail' }, {}, null, deps),
      ).rejects.toThrow(/gmail/i);
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
