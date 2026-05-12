import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';

import {
  MessagingToolError,
  getThreadHandler,
  listThreadsHandler,
  searchHandler,
} from '../tools';

/**
 * Mock the drizzle chain used by tools.ts handlers:
 *   select(cols).from(t).where(c).limit(n)                       — getThread (1st)
 *   select(cols).from(t).where(c).orderBy(...).limit(n)          — getThread (2nd), listThreads, search
 *
 * Each call to `.limit()` resolves to the next row-set in `rowSets`, in the
 * order the handler issues its queries (the helpers in
 * `atlas-events/__tests__/build-envelope.spec.ts` use the same shape).
 */
function makeDb(rowSets: Array<unknown[]>): { db: DB; whereSpy: ReturnType<typeof vi.fn> } {
  const limit = vi.fn();
  for (const rs of rowSets) limit.mockResolvedValueOnce(rs);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const whereSpy = vi.fn().mockReturnValue({ limit, orderBy });
  const from = vi.fn().mockReturnValue({ where: whereSpy });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DB, whereSpy };
}

const convRow = {
  id: 'conv-1',
  accountId: 'account-1',
  inboxId: 'inbox-1',
  contactId: 'contact-1',
  assignedUserId: 'user-1',
  assignedTeamId: null as string | null,
  assignedBotId: null as string | null,
  status: 'open' as const,
  createdAt: new Date('2026-05-10T10:00:00Z'),
  updatedAt: new Date('2026-05-12T12:00:00Z'),
};

const msgRow = {
  id: 'msg-1',
  senderType: 'contact' as const,
  senderId: 'contact-1',
  content: 'hello world',
  contentType: 'text',
  isPrivateNote: false,
  createdAt: new Date('2026-05-12T12:00:00Z'),
};

describe('getThreadHandler', () => {
  it('returns conversation + messages when the conversation exists', async () => {
    const { db } = makeDb([[convRow], [msgRow]]);

    const result = await getThreadHandler(db, { id: convRow.id });

    expect(result.conversation).toMatchObject({
      id: 'conv-1',
      accountId: 'account-1',
      inboxId: 'inbox-1',
      status: 'open',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: 'msg-1',
      senderType: 'contact',
      content: 'hello world',
    });
  });

  it('throws MessagingToolError("not_found") when no conversation matches', async () => {
    const { db } = makeDb([[]]);

    const promise = getThreadHandler(db, {
      id: '00000000-0000-0000-0000-000000000000',
    });

    await expect(promise).rejects.toBeInstanceOf(MessagingToolError);
    await expect(promise).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('listThreadsHandler', () => {
  it('returns conversations with default filter (no inboxId/status/assignee/since)', async () => {
    const rows = [convRow, { ...convRow, id: 'conv-2' }];
    const { db, whereSpy } = makeDb([rows]);

    const result = await listThreadsHandler(db, { limit: 50 });

    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]).toMatchObject({ id: 'conv-1' });
    // Default filter: only the `deletedAt IS NULL` predicate is applied. The
    // and(...conditions) expression is wrapped in a single arg to where.
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('applies status filter when input.status is provided', async () => {
    const resolvedRow = { ...convRow, status: 'resolved' as const };
    const { db, whereSpy } = makeDb([[resolvedRow]]);

    const result = await listThreadsHandler(db, {
      status: 'resolved',
      limit: 50,
    });

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]).toMatchObject({ status: 'resolved' });
    // where() is invoked exactly once with the combined predicate; the
    // resolved-status arg is part of that combined SQL fragment, which we do
    // not introspect further here (drizzle owns that translation).
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });
});

describe('searchHandler', () => {
  it('returns hits when the tsvector query matches messages', async () => {
    const hit = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      inboxId: 'inbox-1',
      senderType: 'contact' as const,
      content: 'hello world',
      createdAt: new Date('2026-05-12T12:00:00Z'),
    };
    const { db } = makeDb([[hit]]);

    const result = await searchHandler(db, { query: 'hello', limit: 20 });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      messageId: 'msg-1',
      content: 'hello world',
    });
  });

  it('returns empty hits when no message matches', async () => {
    const { db } = makeDb([[]]);

    const result = await searchHandler(db, { query: 'nothingmatches', limit: 20 });

    expect(result.hits).toEqual([]);
  });
});
