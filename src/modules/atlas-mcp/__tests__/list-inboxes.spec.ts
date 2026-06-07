import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';

import {
  MessagingToolError,
  capabilitiesForChannel,
  identifierForInbox,
  listInboxesHandler,
} from '../tools';
import { encryptJSON } from '../../../crypto';

/**
 * Mock the drizzle chain used by listInboxesHandler:
 *   select(cols).from(t).where(c).limit(n)      — atlas_user_links lookup
 *   select(cols).from(t).where(c).orderBy(...)  — inboxes list (no limit)
 *
 * Both `.limit()` and `.orderBy()` resolve to the next row-set in the queue,
 * in the order the handler issues its queries: link first, inboxes second.
 */
function makeDb(rowSets: Array<unknown[]>): {
  db: DB;
  whereSpy: ReturnType<typeof vi.fn>;
} {
  const queue = [...rowSets];
  const next = () => Promise.resolve(queue.shift() ?? []);
  const limit = vi.fn(() => next());
  const orderBy = vi.fn(() => next());
  const whereSpy = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where: whereSpy }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as DB, whereSpy };
}

const ATLAS_ORG_ID = 'org-1';
const CTX = { atlasAppUserId: 'atlas-bot:org-1', atlasOrgId: ATLAS_ORG_ID };
const ACCOUNT = 'account-1';

const linkRow = { accountId: ACCOUNT };

function inboxRow(over: Partial<{
  id: string;
  name: string;
  channelType: string;
  enabled: boolean;
  config: unknown;
  secrets: string | null;
  updatedAt: Date;
}>) {
  return {
    id: 'inbox-1',
    name: 'Inbox',
    channelType: 'whatsapp',
    enabled: true,
    config: {},
    secrets: null,
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

describe('capabilitiesForChannel', () => {
  it('advertises outbound only for channels with an axis sender', () => {
    expect(capabilitiesForChannel('whatsapp').supportsOutbound).toBe(true);
    expect(capabilitiesForChannel('email').supportsOutbound).toBe(true);
    expect(capabilitiesForChannel('telegram').supportsOutbound).toBe(true);
    expect(capabilitiesForChannel('sms').supportsOutbound).toBe(false);
    expect(capabilitiesForChannel('instagram').supportsOutbound).toBe(false);
    expect(capabilitiesForChannel('messenger').supportsOutbound).toBe(false);
  });

  it('marks telegram as requiring user-initiated contact', () => {
    expect(capabilitiesForChannel('telegram').requiresUserInit).toBe(true);
    expect(capabilitiesForChannel('whatsapp').requiresUserInit).toBe(false);
  });
});

describe('identifierForInbox', () => {
  it('returns the WhatsApp from-number, falling back to the messaging-service SID', () => {
    expect(identifierForInbox('whatsapp', { fromNumber: '+5511999' })).toBe('+5511999');
    expect(identifierForInbox('whatsapp', { messagingServiceSid: 'MGxxx' })).toBe('MGxxx');
  });
  it('returns the email from-address', () => {
    expect(identifierForInbox('email', { fromEmail: 'a@b.com' })).toBe('a@b.com');
  });
  it('returns null for telegram (no username stored) and unknown shapes', () => {
    expect(identifierForInbox('telegram', { apiBase: 'https://api.telegram.org' })).toBeNull();
    expect(identifierForInbox('whatsapp', {})).toBeNull();
    expect(identifierForInbox('sms', { fromNumber: '+1' })).toBeNull();
  });
});

describe('listInboxesHandler (T-03)', () => {
  it('maps a configured WhatsApp inbox when filtered by channelType', async () => {
    const { db } = makeDb([
      [linkRow],
      [
        inboxRow({
          id: 'wa-1',
          name: 'WhatsApp Suporte',
          channelType: 'whatsapp',
          config: { accountSid: 'ACxxx', fromNumber: '+5511999' },
          secrets: encryptJSON({ authToken: 'tok' }),
        }),
      ],
    ]);

    const result = await listInboxesHandler(db, { channelType: 'whatsapp', enabledOnly: true }, CTX);

    expect(result.inboxes).toHaveLength(1);
    expect(result.inboxes[0]).toMatchObject({
      id: 'wa-1',
      name: 'WhatsApp Suporte',
      channelType: 'whatsapp',
      enabled: true,
      configured: true,
      identifier: '+5511999',
      capabilities: { supportsOutbound: true, requiresTemplate: false, requiresUserInit: false },
    });
  });

  it('returns all inboxes across channels when no filter is given', async () => {
    const { db } = makeDb([
      [linkRow],
      [
        inboxRow({ id: 'a', name: 'A', channelType: 'whatsapp' }),
        inboxRow({ id: 'b', name: 'B', channelType: 'email' }),
        inboxRow({ id: 'c', name: 'C', channelType: 'telegram' }),
      ],
    ]);

    const result = await listInboxesHandler(db, { enabledOnly: true }, CTX);

    expect(result.inboxes.map((i) => i.channelType)).toEqual(['whatsapp', 'email', 'telegram']);
  });

  it('computes `configured` per channel from decrypted secrets', async () => {
    const { db } = makeDb([
      [linkRow],
      [
        // whatsapp fully configured
        inboxRow({
          id: 'wa',
          channelType: 'whatsapp',
          config: { accountSid: 'AC', fromNumber: '+1' },
          secrets: encryptJSON({ authToken: 't' }),
        }),
        // email gmail WITHOUT refresh token → not configured
        inboxRow({
          id: 'em',
          channelType: 'email',
          config: { provider: 'gmail', fromEmail: 'x@y.com' },
          secrets: encryptJSON({}),
        }),
        // telegram with bot token → configured
        inboxRow({
          id: 'tg',
          channelType: 'telegram',
          config: {},
          secrets: encryptJSON({ botToken: 'bt' }),
        }),
      ],
    ]);

    const result = await listInboxesHandler(db, { enabledOnly: true }, CTX);
    const byId = Object.fromEntries(result.inboxes.map((i) => [i.id, i.configured]));
    expect(byId).toEqual({ wa: true, em: false, tg: true });
  });

  it('treats an undecryptable secrets blob as not configured (no throw)', async () => {
    const { db } = makeDb([
      [linkRow],
      [
        inboxRow({
          id: 'wa',
          channelType: 'whatsapp',
          config: { accountSid: 'AC', fromNumber: '+1' },
          secrets: 'garbage-not-a-valid-blob',
        }),
      ],
    ]);

    const result = await listInboxesHandler(db, { enabledOnly: true }, CTX);
    expect(result.inboxes[0]?.configured).toBe(false);
  });

  it('maps disabled inboxes through when enabledOnly is false', async () => {
    const { db } = makeDb([
      [linkRow],
      [inboxRow({ id: 'off', channelType: 'whatsapp', enabled: false })],
    ]);

    const result = await listInboxesHandler(db, { enabledOnly: false }, CTX);
    expect(result.inboxes[0]).toMatchObject({ id: 'off', enabled: false });
  });

  it('throws forbidden when the Atlas org has no atlas-bot link', async () => {
    const { db } = makeDb([[]]);

    const promise = listInboxesHandler(db, { enabledOnly: true }, CTX);
    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws forbidden when the link row has a null account', async () => {
    const { db } = makeDb([[{ accountId: null }]]);

    const promise = listInboxesHandler(db, { enabledOnly: true }, CTX);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('returns an empty list when the account has no matching inboxes', async () => {
    const { db } = makeDb([[linkRow], []]);

    const result = await listInboxesHandler(db, { channelType: 'whatsapp', enabledOnly: true }, CTX);
    expect(result.inboxes).toEqual([]);
  });
});
