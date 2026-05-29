import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';

import { eventBus, type RealtimeEvent } from '../../../realtime/event-bus';
import { emitConversationTagged } from '../tagged-trigger';

/**
 * [crm-T-03] Unit tests for the `conversation.tagged` realtime trigger:
 *   - empty tagIds → noop (no DB read, no emit)
 *   - missing conversation → noop (race with delete)
 *   - one event per tagId, all sharing one `taggedAt`
 *
 * Routing (qualified → buildLeadQualifiedEnvelope) lives in enqueue.spec.ts.
 */

function makeDb(convInboxId: string | null): DB {
  const rows = convInboxId === null ? [] : [{ inboxId: convInboxId }];
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as DB;
}

describe('emitConversationTagged', () => {
  const events: RealtimeEvent[] = [];
  let unsub: () => void;

  beforeEach(() => {
    events.length = 0;
    unsub = eventBus.onEvent((e) => events.push(e));
  });
  afterEach(() => {
    unsub();
  });

  it('is a no-op when tagIds is empty (no DB read, no emit)', async () => {
    const db = makeDb('inbox-1');
    await emitConversationTagged(db, { conversationId: 'conv-1', tagIds: [] });
    expect(events).toHaveLength(0);
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it('is a no-op when the conversation row is gone (race with delete)', async () => {
    const db = makeDb(null);
    await emitConversationTagged(db, {
      conversationId: 'conv-gone',
      tagIds: ['tag-1'],
    });
    expect(events).toHaveLength(0);
  });

  it('emits one conversation.tagged event per tagId with the resolved inboxId', async () => {
    const db = makeDb('inbox-7');
    await emitConversationTagged(db, {
      conversationId: 'conv-77',
      tagIds: ['tag-a', 'tag-b'],
      taggedAt: '2026-05-29T12:00:00.000Z',
    });
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      {
        type: 'conversation.tagged',
        inboxId: 'inbox-7',
        conversationId: 'conv-77',
        tagId: 'tag-a',
        taggedAt: '2026-05-29T12:00:00.000Z',
      },
      {
        type: 'conversation.tagged',
        inboxId: 'inbox-7',
        conversationId: 'conv-77',
        tagId: 'tag-b',
        taggedAt: '2026-05-29T12:00:00.000Z',
      },
    ]);
  });

  it('captures a default taggedAt (now) shared across the batch when none is provided', async () => {
    const db = makeDb('inbox-9');
    const before = Date.now();
    await emitConversationTagged(db, {
      conversationId: 'conv-9',
      tagIds: ['t1', 't2', 't3'],
    });
    const after = Date.now();

    expect(events).toHaveLength(3);
    const taggedAts = events.map((e) =>
      e.type === 'conversation.tagged' ? e.taggedAt : null,
    );
    // All three share the same captured timestamp (one Date.now per call).
    expect(new Set(taggedAts).size).toBe(1);
    const ts = Date.parse(taggedAts[0]!);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
