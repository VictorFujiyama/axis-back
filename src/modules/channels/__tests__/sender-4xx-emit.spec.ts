import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '@blossom/db';
import { sendOutboundWhatsApp } from '../whatsapp-sender.js';
import { sendViaPostmark } from '../email-sender.js';
import { sendOutboundTwilio } from '../twilio-shared.js';
import type { EmitMessageFailedParams } from '../../atlas-events/enqueue';

/**
 * [marketing-T-10] Senders emit `message.failed` (via the injected
 * `onPermanentFailure` callback) ONLY on a provider 4xx permanent reject — the
 * site that marks `failedAt` and returns WITHOUT throwing, so the worker's
 * `markFailedOnExhaust` (`failed` event) never covers it. Transient 5xx/network
 * (throws → BullMQ retries → exhaustion handler emits) and config-missing
 * pre-flight failures (org-level, not a contact bounce) do NOT emit.
 */

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
  setPayloads: Array<Record<string, unknown>>;
}

/** Drizzle-shaped stub: select().from().where().limit() → selectRows; captures update().set() payloads. */
function buildDb(selectRows: unknown[] = [{ deliveredAt: null, failedAt: null, channelMsgId: null }]): DbStub {
  const setPayloads: Array<Record<string, unknown>> = [];
  const limit = vi.fn().mockResolvedValue(selectRows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn((payload: Record<string, unknown>) => {
    setPayloads.push(payload);
    return { where: updateWhere };
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return { db: { select, update } as unknown as DB, setPayloads };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const fn =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const WA_CONFIG = { provider: 'twilio' as const, accountSid: 'AC123', fromNumber: '+15550001111' };
const WA_SECRETS = { authToken: 'tok-abc' };
const WA_INPUT = {
  messageId: 'msg-wa',
  conversationId: 'conv-wa',
  inboxId: 'inbox-wa',
  contactPhone: '+5511999998888',
  text: 'hi',
};

const PM_CONFIG = { fromEmail: 'agent@acme.com' };
const PM_SECRETS = { serverToken: 'pm-tok' };
const PM_INPUT = {
  messageId: 'msg-pm',
  conversationId: 'conv-pm',
  inboxId: 'inbox-pm',
  contactEmail: 'lead@example.com',
  subject: 'Hi',
  text: 'hello',
};

const TW_INPUT = {
  messageId: 'msg-ig',
  conversationId: 'conv-ig',
  inboxId: 'inbox-ig',
  contactAddress: '17999',
  text: 'hi',
};
const TW_CONFIG = { accountSid: 'AC123', fromNumber: '12345' };
const TW_SECRETS = { authToken: 'tok-ig' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('[T-10] whatsapp-sender onPermanentFailure', () => {
  it('provider 4xx → calls onPermanentFailure with channel whatsapp + matching failedAt', async () => {
    stubFetch(jsonResponse({ message: 'Invalid recipient', code: 21211 }, 422));
    const { db, setPayloads } = buildDb();
    const emit = vi.fn<(p: EmitMessageFailedParams) => void>();

    await sendOutboundWhatsApp(WA_INPUT, WA_CONFIG, WA_SECRETS, null, {
      db,
      log: buildLog(),
      onPermanentFailure: emit,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const p = emit.mock.calls[0]![0];
    expect(p).toMatchObject({
      messageId: 'msg-wa',
      conversationId: 'conv-wa',
      inboxId: 'inbox-wa',
      channel: 'whatsapp',
      failureReason: 'Invalid recipient',
    });
    // failedAt is the SAME Date written to the row (not a fresh now()).
    expect(p.failedAt).toBeInstanceOf(Date);
    expect(setPayloads.at(-1)).toMatchObject({ failedAt: p.failedAt, failureReason: 'Invalid recipient' });
  });

  it('transient 5xx → throws, onPermanentFailure NOT called', async () => {
    stubFetch(jsonResponse({ message: 'server error' }, 503));
    const { db } = buildDb();
    const emit = vi.fn();

    await expect(
      sendOutboundWhatsApp(WA_INPUT, WA_CONFIG, WA_SECRETS, null, { db, log: buildLog(), onPermanentFailure: emit }),
    ).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it('2xx success → onPermanentFailure NOT called', async () => {
    stubFetch(jsonResponse({ sid: 'SM1' }, 201));
    const { db } = buildDb();
    const emit = vi.fn();

    await sendOutboundWhatsApp(WA_INPUT, WA_CONFIG, WA_SECRETS, null, { db, log: buildLog(), onPermanentFailure: emit });
    expect(emit).not.toHaveBeenCalled();
  });

  it('config-missing (no authToken) → marks failed but does NOT emit', async () => {
    const fetchMock = stubFetch(jsonResponse({}, 200));
    const { db, setPayloads } = buildDb();
    const emit = vi.fn();

    await sendOutboundWhatsApp(WA_INPUT, WA_CONFIG, { authToken: undefined }, null, {
      db,
      log: buildLog(),
      onPermanentFailure: emit,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setPayloads.at(-1)).toMatchObject({ failureReason: 'no authToken configured' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('no callback wired → 4xx still marks failed, no throw (back-compat)', async () => {
    stubFetch(jsonResponse({ message: 'bad', code: 21211 }, 400));
    const { db, setPayloads } = buildDb();

    await expect(
      sendOutboundWhatsApp(WA_INPUT, WA_CONFIG, WA_SECRETS, null, { db, log: buildLog() }),
    ).resolves.toBeUndefined();
    expect(setPayloads.at(-1)).toMatchObject({ failureReason: 'bad' });
  });
});

describe('[T-10] postmark sendViaPostmark onPermanentFailure', () => {
  it('provider 4xx → calls onPermanentFailure with channel email', async () => {
    stubFetch(jsonResponse({ Message: 'Invalid email address', ErrorCode: 300 }, 422));
    const { db } = buildDb([{ deliveredAt: null, failedAt: null }]);
    const emit = vi.fn<(p: EmitMessageFailedParams) => void>();

    await sendViaPostmark(PM_INPUT, PM_CONFIG, PM_SECRETS, null, { db, log: buildLog(), onPermanentFailure: emit });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      messageId: 'msg-pm',
      channel: 'email',
      failureReason: 'Invalid email address',
    });
  });

  it('config-missing (no serverToken) → marks failed but does NOT emit', async () => {
    const fetchMock = stubFetch(jsonResponse({}, 200));
    const { db } = buildDb([{ deliveredAt: null, failedAt: null }]);
    const emit = vi.fn();

    await sendViaPostmark(PM_INPUT, PM_CONFIG, { serverToken: undefined }, null, {
      db,
      log: buildLog(),
      onPermanentFailure: emit,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('[T-10] twilio-shared sendOutboundTwilio onPermanentFailure', () => {
  it('provider 4xx → calls onPermanentFailure with channel = prefix', async () => {
    stubFetch(jsonResponse({ message: 'blocked', code: 63016 }, 400));
    const { db } = buildDb();
    const emit = vi.fn<(p: EmitMessageFailedParams) => void>();

    await sendOutboundTwilio('instagram', TW_INPUT, TW_CONFIG, TW_SECRETS, null, {
      db,
      log: buildLog(),
      onPermanentFailure: emit,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      messageId: 'msg-ig',
      channel: 'instagram',
      failureReason: 'blocked',
    });
  });

  it('transient 5xx → throws, onPermanentFailure NOT called', async () => {
    stubFetch(jsonResponse({ message: 'oops' }, 500));
    const { db } = buildDb();
    const emit = vi.fn();

    await expect(
      sendOutboundTwilio('messenger', TW_INPUT, TW_CONFIG, TW_SECRETS, null, {
        db,
        log: buildLog(),
        onPermanentFailure: emit,
      }),
    ).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});
