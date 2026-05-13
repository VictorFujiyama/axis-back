import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';
import {
  buildConversationTurnEnvelope,
  buildHandoffEnvelope,
  buildResolvedEnvelope,
  mapActors,
} from '../build-envelope';

function makeDb(rowSets: Array<unknown[]>): DB {
  const limit = vi.fn();
  for (const rs of rowSets) limit.mockResolvedValueOnce(rs);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as DB;
}

const convRow = {
  id: 'conv-1',
  inboxId: 'inbox-1',
  contactId: 'contact-1',
  assignedUserId: 'user-1',
  assignedTeamId: null as string | null,
};
const inboxRow = { id: 'inbox-1', accountId: 'account-1' };

describe('build-envelope helpers', () => {
  it('buildConversationTurnEnvelope — contact-sent message', async () => {
    const msgRow = {
      id: 'msg-1',
      conversationId: 'conv-1',
      senderType: 'contact',
      senderId: 'contact-1',
      content: 'hello world',
      createdAt: new Date('2026-05-12T12:00:00Z'),
    };
    const db = makeDb([[convRow], [inboxRow], [msgRow]]);

    const env = await buildConversationTurnEnvelope(db, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      action: 'create',
    });

    expect(env).toMatchObject({
      kind: 'conversation_turn',
      action: 'create',
      sourceRef: 'conv-1:message_sent:msg-1',
      accountId: 'account-1',
      summary: 'contact: hello world',
      occurredAt: '2026-05-12T12:00:00.000Z',
      actors: [{ kind: 'contact', id: 'contact-1' }],
      participants: [
        { kind: 'contact', id: 'contact-1' },
        { kind: 'user', id: 'user-1' },
      ],
      viewableBy: { scope: 'org' },
    });
  });

  it('buildConversationTurnEnvelope — bot-sent message with atlasMeta.app_user_id', async () => {
    const msgRow = {
      id: 'msg-2',
      conversationId: 'conv-1',
      senderType: 'bot',
      senderId: 'bot-axis-1',
      content: 'auto reply',
      createdAt: new Date('2026-05-12T12:01:00Z'),
    };
    const db = makeDb([[convRow], [inboxRow], [msgRow]]);

    const env = await buildConversationTurnEnvelope(db, {
      conversationId: 'conv-1',
      messageId: 'msg-2',
      action: 'create',
      atlasMeta: { atlasAppUserId: 'user_clerk_atlas_999' },
    });

    expect(env.actors).toEqual([
      { kind: 'bot', id: 'bot-axis-1', appUserId: 'user_clerk_atlas_999' },
    ]);
    expect(env.participants).toEqual(
      expect.arrayContaining([
        { kind: 'contact', id: 'contact-1' },
        { kind: 'user', id: 'user-1' },
        { kind: 'bot', id: 'bot-axis-1' },
      ]),
    );
    expect(env.summary).toBe('bot: auto reply');
  });

  it('buildConversationTurnEnvelope — long content gets sliced to 200 chars', async () => {
    const long = 'x'.repeat(500);
    const msgRow = {
      id: 'msg-long',
      conversationId: 'conv-1',
      senderType: 'contact',
      senderId: 'contact-1',
      content: long,
      createdAt: new Date('2026-05-12T12:02:00Z'),
    };
    const db = makeDb([[convRow], [inboxRow], [msgRow]]);

    const env = await buildConversationTurnEnvelope(db, {
      conversationId: 'conv-1',
      messageId: 'msg-long',
      action: 'create',
    });

    expect(env.summary.length).toBe(200);
  });

  it('buildHandoffEnvelope — bot → user with assignedUserId', async () => {
    const db = makeDb([[convRow], [inboxRow]]);

    const env = await buildHandoffEnvelope(db, {
      type: 'conversation.assigned',
      inboxId: 'inbox-1',
      conversationId: 'conv-1',
      assignedUserId: 'user-99',
      assignedTeamId: null,
      assignedBotId: null,
    });

    expect(env).toMatchObject({
      kind: 'conversation_turn',
      action: 'update',
      accountId: 'account-1',
      summary: 'Handoff: bot → user',
      actors: [],
      participants: expect.arrayContaining([
        { kind: 'contact', id: 'contact-1' },
        { kind: 'user', id: 'user-99' },
      ]),
      viewableBy: { scope: 'org' },
    });
    expect(env.sourceRef).toMatch(/^conv-1:handoff:\d+$/);
  });

  it('buildResolvedEnvelope', async () => {
    const db = makeDb([[convRow], [inboxRow]]);

    const env = await buildResolvedEnvelope(db, {
      type: 'conversation.resolved',
      inboxId: 'inbox-1',
      conversationId: 'conv-1',
      resolvedBy: 'user-1',
    });

    expect(env).toMatchObject({
      kind: 'conversation_turn',
      action: 'update',
      sourceRef: 'conv-1:resolved',
      summary: 'Resolved',
      accountId: 'account-1',
      actors: [],
      participants: expect.arrayContaining([
        { kind: 'contact', id: 'contact-1' },
        { kind: 'user', id: 'user-1' },
      ]),
    });
  });

  it('mapActors — bot without atlasMeta falls back to plain bot actor', () => {
    expect(mapActors('bot', 'bot-1')).toEqual([{ kind: 'bot', id: 'bot-1' }]);
  });

  it('mapActors — senderId null returns empty actors', () => {
    expect(mapActors('system', null)).toEqual([]);
  });

  it('buildConversationTurnEnvelope — throws when conversation row missing', async () => {
    const db = makeDb([[]]);
    await expect(
      buildConversationTurnEnvelope(db, {
        conversationId: 'conv-missing',
        messageId: 'msg-x',
        action: 'create',
      }),
    ).rejects.toThrow(/conversation conv-missing not found/);
  });

  it('buildConversationTurnEnvelope — throws when inbox accountId is null', async () => {
    const db = makeDb([[convRow], [{ id: 'inbox-1', accountId: null }]]);
    await expect(
      buildConversationTurnEnvelope(db, {
        conversationId: 'conv-1',
        messageId: 'msg-1',
        action: 'create',
      }),
    ).rejects.toThrow(/missing accountId/);
  });
});
