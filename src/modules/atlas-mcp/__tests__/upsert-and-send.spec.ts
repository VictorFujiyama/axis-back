import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';

import {
  MessagingToolError,
  mapProviderError,
  upsertAndSendHandler,
  type UpsertAndSendInput,
} from '../tools';
import { ERR } from '../errors';
import { encryptJSON } from '../../../crypto';
import { eventBus } from '../../../realtime/event-bus';

/**
 * Sequential drizzle mock for upsertAndSendHandler. The handler issues, in
 * order, a mix of:
 *   - select(...).from(...)[.innerJoin(...)] .where(...)[.orderBy(...)].limit(1)
 *   - insert(...).values(...).returning([cols])          (contact/conversation/message)
 *   - insert(...).values(...).onConflictDoNothing()      (telegram identity — awaited)
 *   - update(...).set(...).where(...)                    (conversation bump / ref back-fill)
 *
 * `selectLimits` feeds every `.limit()` in call order; `insertReturnings` feeds
 * every `.returning(...)` in call order. `insertValues` is exposed so tests can
 * assert what was written (e.g. message contentType / metadata).
 */
function makeUpsertDb(opts: {
  selectLimits?: Array<unknown[]>;
  insertReturnings?: Array<unknown[]>;
}): {
  db: DB;
  insertValues: ReturnType<typeof vi.fn>;
  updateSet: ReturnType<typeof vi.fn>;
} {
  const selectLimit = vi.fn();
  for (const rs of opts.selectLimits ?? []) selectLimit.mockResolvedValueOnce(rs);
  selectLimit.mockResolvedValue([]); // any extra select defaults to empty
  const orderBy = vi.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit, orderBy });
  const innerJoin = vi.fn().mockReturnValue({ where: selectWhere });
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere, innerJoin });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  const insertReturning = vi.fn();
  for (const rs of opts.insertReturnings ?? []) insertReturning.mockResolvedValueOnce(rs);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: { select, insert, update } as unknown as DB,
    insertValues,
    updateSet,
  };
}

const ATLAS_ORG_ID = 'org-1';
const CTX = { atlasAppUserId: 'atlas-bot:org-1', atlasOrgId: ATLAS_ORG_ID };
const ACCOUNT = 'account-1';
const INBOX_ID = '11111111-1111-1111-1111-111111111111';
const CONTACT_ID = '22222222-2222-2222-2222-222222222222';
const CONV_ID = '33333333-3333-3333-3333-333333333333';
const MSG_ID = '44444444-4444-4444-4444-444444444444';

const linkRow = { accountId: ACCOUNT };
const botRow = { id: 'bot-1', email: 'atlas-bot+account-1@atlas.internal', name: 'Atlas Assistant' };

function whatsappInboxRow(over: Record<string, unknown> = {}) {
  return {
    id: INBOX_ID,
    channelType: 'whatsapp',
    enabled: true,
    config: { accountSid: 'ACxxx', fromNumber: '+5511000' },
    secrets: encryptJSON({ authToken: 'tok' }),
    defaultBotId: null,
    ...over,
  };
}

function insertedMsgRow(over: Record<string, unknown> = {}) {
  return {
    id: MSG_ID,
    conversationId: CONV_ID,
    inboxId: INBOX_ID,
    senderType: 'bot',
    senderId: botRow.id,
    content: 'Olá',
    contentType: 'text',
    mediaUrl: null,
    mediaMimeType: null,
    isPrivateNote: false,
    createdAt: new Date('2026-06-07T12:00:00Z'),
    ...over,
  };
}

function baseInput(over: Partial<UpsertAndSendInput> = {}): UpsertAndSendInput {
  return {
    inboxId: INBOX_ID,
    contact: { identifier: { phone: '+5511999' } },
    message: { content: 'Olá', contentType: 'text' },
    conversationStrategy: 'reuse-open',
    metadata: { atlasJourneyRunId: 'run-1', atlasNodeId: 'node-1' },
    ...over,
  } as UpsertAndSendInput;
}

const appStub = { log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as never;

describe('mapProviderError (D14)', () => {
  it('maps Twilio 63016 (freeform outside 24h) to OUTSIDE_24H_WINDOW', () => {
    expect(mapProviderError({ providerCode: 63016 })).toBe(ERR.OUTSIDE_24H_WINDOW);
    expect(mapProviderError({ providerCode: '63016' })).toBe(ERR.OUTSIDE_24H_WINDOW);
  });
  it('maps HTTP 429 / Twilio 63018 to PROVIDER_RATE_LIMITED', () => {
    expect(mapProviderError({ httpStatus: 429 })).toBe(ERR.PROVIDER_RATE_LIMITED);
    expect(mapProviderError({ providerCode: 63018 })).toBe(ERR.PROVIDER_RATE_LIMITED);
  });
  it('maps 5xx to PROVIDER_TRANSIENT (retriable)', () => {
    expect(mapProviderError({ httpStatus: 503 })).toBe(ERR.PROVIDER_TRANSIENT);
  });
  it('maps other 4xx to PROVIDER_REJECTED (non-retriable)', () => {
    expect(mapProviderError({ httpStatus: 400 })).toBe(ERR.PROVIDER_REJECTED);
    expect(mapProviderError({})).toBe(ERR.PROVIDER_REJECTED);
  });
});

describe('upsertAndSendHandler (T-05)', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('happy path WhatsApp freeform: creates contact + conversation, inserts message, emits event', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow], // D27 link
        [whatsappInboxRow()], // inbox
        [], // idempotency miss
        [], // phone/email lookup miss
        [], // reuse-open conversation miss
        [botRow], // getOrCreateAtlasBotUser hit
      ],
      insertReturnings: [
        [{ id: CONTACT_ID }], // contact create
        [{ id: CONV_ID }], // conversation create
        [insertedMsgRow()], // message insert
      ],
    });

    const result = await upsertAndSendHandler(db, appStub, baseInput(), CTX);

    expect(result).toEqual({
      conversationId: CONV_ID,
      messageId: MSG_ID,
      createdNewConversation: true,
      createdNewContact: true,
    });
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.created',
        conversationId: CONV_ID,
        inboxId: INBOX_ID,
        meta: { atlasAppUserId: CTX.atlasAppUserId, atlasOrgId: ATLAS_ORG_ID },
      }),
    );
  });

  it('stamps metadata.source=atlas-journey + run/node ids on the inserted message (D5/D6)', async () => {
    const { db, insertValues } = makeUpsertDb({
      selectLimits: [[linkRow], [whatsappInboxRow()], [], [], [], [botRow]],
      insertReturnings: [[{ id: CONTACT_ID }], [{ id: CONV_ID }], [insertedMsgRow()]],
    });

    await upsertAndSendHandler(db, appStub, baseInput(), CTX);

    const msgInsert = insertValues.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((v) => v.senderType === 'bot');
    expect(msgInsert?.metadata).toMatchObject({
      source: 'atlas-journey',
      atlas_journey_run_id: 'run-1',
      atlas_node_id: 'node-1',
    });
  });

  it('happy path template: persists contentType=template + templateRef in metadata', async () => {
    const { db, insertValues } = makeUpsertDb({
      selectLimits: [[linkRow], [whatsappInboxRow()], [], [], [], [botRow]],
      insertReturnings: [
        [{ id: CONTACT_ID }],
        [{ id: CONV_ID }],
        [insertedMsgRow({ contentType: 'template', content: '' })],
      ],
    });

    await upsertAndSendHandler(
      db,
      appStub,
      baseInput({
        message: {
          content: '',
          contentType: 'template',
          templateRef: { provider: 'twilio', sid: 'HXabc', variables: { '1': 'João' } },
        },
      }),
      CTX,
    );

    const msgInsert = insertValues.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((v) => v.senderType === 'bot');
    expect(msgInsert?.contentType).toBe('template');
    expect(msgInsert?.metadata).toMatchObject({
      template: { provider: 'twilio', sid: 'HXabc', variables: { '1': 'João' } },
    });
  });

  it('contact resolution: explicit axisContactId is used directly', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow()],
        [], // idempotency miss
        [{ id: CONTACT_ID }], // axisContactId lookup hit
        [], // reuse-open conversation miss
        [botRow],
      ],
      insertReturnings: [[{ id: CONV_ID }], [insertedMsgRow()]],
    });

    const result = await upsertAndSendHandler(
      db,
      appStub,
      baseInput({ contact: { axisContactId: CONTACT_ID } }),
      CTX,
    );

    expect(result.createdNewContact).toBe(false);
    expect(result.conversationId).toBe(CONV_ID);
  });

  it('contact resolution: matches a remembered external ref (entity-link analog)', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow()],
        [], // idempotency miss
        [{ id: CONTACT_ID }], // external-ref lookup hit
        [], // reuse-open conversation miss
        [botRow],
      ],
      insertReturnings: [[{ id: CONV_ID }], [insertedMsgRow()]],
    });

    const result = await upsertAndSendHandler(
      db,
      appStub,
      baseInput({
        contact: { externalContactRef: { source: 'atlas', externalId: 'atlas-c-1' } },
      }),
      CTX,
    );

    expect(result.createdNewContact).toBe(false);
  });

  it('contact resolution: matches an existing contact by phone', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow()],
        [], // idempotency miss
        [{ id: CONTACT_ID }], // phone/email lookup hit
        [], // reuse-open conversation miss
        [botRow],
      ],
      insertReturnings: [[{ id: CONV_ID }], [insertedMsgRow()]],
    });

    const result = await upsertAndSendHandler(db, appStub, baseInput(), CTX);
    expect(result.createdNewContact).toBe(false);
  });

  it('reuses an open conversation when one exists (createdNewConversation=false)', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow()],
        [], // idempotency miss
        [{ id: CONTACT_ID }], // phone lookup hit
        [{ id: CONV_ID }], // reuse-open conversation hit
        [botRow],
      ],
      insertReturnings: [[insertedMsgRow()]],
    });

    const result = await upsertAndSendHandler(db, appStub, baseInput(), CTX);
    expect(result).toEqual({
      conversationId: CONV_ID,
      messageId: MSG_ID,
      createdNewConversation: false,
      createdNewContact: false,
    });
  });

  it('idempotency: a prior send for the same run+node returns the existing ids, no insert/emit', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow()],
        [{ id: MSG_ID, conversationId: CONV_ID }], // idempotency HIT
      ],
    });

    const result = await upsertAndSendHandler(db, appStub, baseInput(), CTX);
    expect(result).toEqual({
      conversationId: CONV_ID,
      messageId: MSG_ID,
      createdNewConversation: false,
      createdNewContact: false,
    });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws INBOX_NOT_FOUND when the inbox is missing/deleted/cross-account', async () => {
    const { db } = makeUpsertDb({ selectLimits: [[linkRow], []] });

    const promise = upsertAndSendHandler(db, appStub, baseInput(), CTX);
    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ errCode: ERR.INBOX_NOT_FOUND });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('throws INBOX_DISABLED when the inbox is disabled', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [[linkRow], [whatsappInboxRow({ enabled: false })]],
    });

    const promise = upsertAndSendHandler(db, appStub, baseInput(), CTX);
    await expect(promise).rejects.toMatchObject({ errCode: ERR.INBOX_DISABLED });
  });

  it('throws CHANNEL_NOT_IMPLEMENTED for a stub channel (sms) before the configured check', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow({ channelType: 'sms', config: {}, secrets: null })],
      ],
    });

    const promise = upsertAndSendHandler(db, appStub, baseInput(), CTX);
    await expect(promise).rejects.toMatchObject({ errCode: ERR.CHANNEL_NOT_IMPLEMENTED });
  });

  it('throws INBOX_NOT_CONFIGURED when send credentials are missing', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow({ secrets: encryptJSON({}) })], // no authToken
      ],
    });

    const promise = upsertAndSendHandler(db, appStub, baseInput(), CTX);
    await expect(promise).rejects.toMatchObject({ errCode: ERR.INBOX_NOT_CONFIGURED });
  });

  it('throws forbidden when the Atlas org has no atlas-bot link', async () => {
    const { db } = makeUpsertDb({ selectLimits: [[]] });

    const promise = upsertAndSendHandler(db, appStub, baseInput(), CTX);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws CONTACT_RESOLUTION_FAILED when an explicit axisContactId is unknown', async () => {
    const { db } = makeUpsertDb({
      selectLimits: [
        [linkRow],
        [whatsappInboxRow()],
        [], // idempotency miss
        [], // axisContactId lookup MISS
      ],
    });

    const promise = upsertAndSendHandler(
      db,
      appStub,
      baseInput({ contact: { axisContactId: CONTACT_ID } }),
      CTX,
    );
    await expect(promise).rejects.toMatchObject({ errCode: ERR.CONTACT_RESOLUTION_FAILED });
  });
});
