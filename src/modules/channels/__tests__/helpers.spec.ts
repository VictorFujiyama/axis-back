import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '@blossom/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ingestIncomingMessage, type IncomingMessage } from '../helpers';
import { eventBus } from '../../../realtime/event-bus';

const INBOX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const CONTACT_ID = '22222222-2222-2222-2222-222222222222';
const CONV_ID = '33333333-3333-3333-3333-333333333333';
const MSG_ID = '44444444-4444-4444-4444-444444444444';

/**
 * Build a DB stub that:
 *  1. Answers the pre-tx `select({accountId, deletedAt}).from(inboxes)` with
 *     `{ accountId: ACCOUNT_ID, deletedAt: null }` so the ingest continues.
 *  2. Short-circuits `db.transaction(cb)` by resolving directly to the shape
 *     `ingestIncomingMessage` expects (contactId / conversationId / message row
 *     with `metadata` echoed back). This test isn't about the tx internals; it
 *     is about the post-tx event-emit branch, so bypassing the callback keeps
 *     the mock small and honest about what we're asserting.
 *  3. Answers the second, post-tx `select({assignedBotId, accountId})` for the
 *     conversation-bot lookup with `assignedBotId: null` so `dispatchBot` is
 *     not called (test scope is limited to the event bus).
 */
function makeDb(persistedMetadata: Record<string, unknown>): DB {
  const inboxLookupLimit = vi
    .fn()
    .mockResolvedValue([{ accountId: ACCOUNT_ID, deletedAt: null }]);
  const inboxLookupWhere = vi
    .fn()
    .mockReturnValue({ limit: inboxLookupLimit });
  const inboxLookupFrom = vi
    .fn()
    .mockReturnValue({ where: inboxLookupWhere });

  const convBotLookupLimit = vi
    .fn()
    .mockResolvedValue([{ assignedBotId: null, accountId: ACCOUNT_ID }]);
  const convBotLookupWhere = vi
    .fn()
    .mockReturnValue({ limit: convBotLookupLimit });
  const convBotLookupFrom = vi
    .fn()
    .mockReturnValue({ where: convBotLookupWhere });

  const dbSelect = vi
    .fn()
    .mockReturnValueOnce({ from: inboxLookupFrom }) // pre-tx inbox lookup
    .mockReturnValueOnce({ from: convBotLookupFrom }); // post-tx bot lookup

  const message = {
    id: MSG_ID,
    conversationId: CONV_ID,
    inboxId: INBOX_ID,
    accountId: ACCOUNT_ID,
    senderType: 'contact' as const,
    senderId: CONTACT_ID,
    content: 'ping',
    contentType: 'text' as const,
    mediaUrl: null,
    mediaMimeType: null,
    channelMsgId: '<test@example.com>',
    metadata: persistedMetadata,
    isPrivateNote: false,
    deliveredAt: new Date(),
    createdAt: new Date(),
  };

  const transaction = vi.fn().mockResolvedValue({
    contactId: CONTACT_ID,
    conversationId: CONV_ID,
    messageId: MSG_ID,
    deduped: false,
    blocked: false,
    message,
  });

  return {
    select: dbSelect,
    transaction,
  } as unknown as DB;
}

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as unknown as FastifyBaseLogger;
}

function buildInput(
  metadata: Record<string, unknown> | undefined,
): IncomingMessage {
  return {
    inboxId: INBOX_ID,
    channel: 'email',
    from: {
      identifier: 'client@example.com',
      email: 'client@example.com',
      name: 'Client',
    },
    content: 'ping',
    contentType: 'text',
    channelMsgId: '<test@example.com>',
    metadata,
  };
}

describe('ingestIncomingMessage — auto-responder event suppression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT emit message.created when input.metadata.autoResponder is true (kills bot loop)', async () => {
    const emit = vi.spyOn(eventBus, 'emitEvent');
    const persistedMetadata = { autoResponder: true };
    const db = makeDb(persistedMetadata);
    const log = makeLog();

    await ingestIncomingMessage(buildInput(persistedMetadata), { db, log });

    const messageCreatedCalls = emit.mock.calls.filter(
      (call) => (call[0] as { type?: string }).type === 'message.created',
    );
    expect(messageCreatedCalls).toHaveLength(0);
  });

  it('logs at info level when suppressing the event (observable behavior)', async () => {
    vi.spyOn(eventBus, 'emitEvent');
    const persistedMetadata = { autoResponder: true };
    const db = makeDb(persistedMetadata);
    const log = makeLog();

    await ingestIncomingMessage(buildInput(persistedMetadata), { db, log });

    const infoCalls = (log.info as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    const suppressedLog = infoCalls.some(
      (call) =>
        typeof call[1] === 'string' &&
        /auto.?responder/i.test(call[1] as string) &&
        /suppress/i.test(call[1] as string),
    );
    expect(suppressedLog).toBe(true);
  });

  it('DOES emit message.created on a normal inbound (regression guard)', async () => {
    const emit = vi.spyOn(eventBus, 'emitEvent');
    const db = makeDb({});
    const log = makeLog();

    await ingestIncomingMessage(buildInput({}), { db, log });

    const messageCreatedCalls = emit.mock.calls.filter(
      (call) => (call[0] as { type?: string }).type === 'message.created',
    );
    expect(messageCreatedCalls).toHaveLength(1);
  });
});
