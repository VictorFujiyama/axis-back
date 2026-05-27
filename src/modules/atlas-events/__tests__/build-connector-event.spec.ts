import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';
import { parseConnectorEvent } from '@atlas/connectors';

// build-connector-event reads `config.ATLAS_ORG_ID` (optional in real config,
// so unset in the test env). It must be a valid UUID or `validateConnectorEvent`
// throws on every build (historic note, T-004a). Pin the real connector org id.
// Path is resolved relative to THIS test file: src/modules/atlas-events/__tests__/
// → three levels up reaches src/config (the same module build-connector-event imports).
vi.mock('../../../config', () => ({
  config: { ATLAS_ORG_ID: '220ef5e0-47df-4493-ae4d-ec0dfe83cabd' },
}));

import {
  buildContactEvent,
  buildConversationSummaryEvent,
  buildConversationTurnEvent,
  buildHandoffEvent,
  resolveActorHints,
} from '../build-connector-event';

// Every builder query is select→from→where→limit(1). makeDb hands back one row
// set per query, in call order. See build-envelope.spec.ts for the precedent.
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
};
const inboxRow = { accountId: 'account-1' };
const contactHints = { email: 'joao@example.com', phone: '+5511999999999', name: 'João' };
const userHints = { email: 'agent@blossom.com', name: 'Agent Smith' };

describe('build-connector-event builders', () => {
  it('conversation_turn (contact sender) — valid envelope + sender hints', async () => {
    const msgRow = {
      id: 'msg-1',
      senderType: 'contact',
      senderId: 'contact-1',
      content: 'hello world',
      createdAt: new Date('2026-05-12T12:00:00Z'),
    };
    // loadConversation, loadAccountId, loadMessage, sender hints, participant
    // contact, participant user.
    const db = makeDb([[convRow], [inboxRow], [msgRow], [contactHints], [contactHints], [userHints]]);

    const ev = await buildConversationTurnEvent(db, {
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.event_id).toBe('msg_msg-1');
    expect(ev.kind).toBe('conversation_turn');
    expect(ev.source_ref).toEqual({ id: 'msg-1', parent_id: 'conv-1' });
    expect(ev.actors[0]?.role).toBe('sender');
    expect(ev.actors[0]?.hints?.email).toBe('joao@example.com');
    expect(ev.actors[0]?.hints?.phone).toBe('+5511999999999');
    // participants carry contact + assigned user, each with hints.
    expect(ev.participants).toHaveLength(2);
    expect(ev.participants[1]?.hints?.email).toBe('agent@blossom.com');
  });

  it('conversation_turn (bot sender) — valid envelope + atlas_user_id hint', async () => {
    const msgRow = {
      id: 'msg-2',
      senderType: 'bot',
      senderId: 'bot-axis-1',
      content: 'auto reply',
      createdAt: new Date('2026-05-12T12:01:00Z'),
    };
    // bot sender resolves without a DB query: conv, inbox, message, then the
    // two participants.
    const db = makeDb([[convRow], [inboxRow], [msgRow], [contactHints], [userHints]]);

    const ev = await buildConversationTurnEvent(db, {
      conversationId: 'conv-1',
      messageId: 'msg-2',
      meta: { atlasAppUserId: 'user_clerk_atlas_999' },
    });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.actors[0]?.role).toBe('sender');
    expect(ev.actors[0]?.app_user_id).toBe('bot-axis-1');
    expect(ev.actors[0]?.hints?.atlas_user_id).toBe('user_clerk_atlas_999');
    // bot/system turns skip the embed budget (spec §12.1.06).
    expect(ev.embedding_text).toBeNull();
  });

  it('conversation_summary — valid envelope + resolved event_id', async () => {
    const db = makeDb([[convRow], [inboxRow], [contactHints], [userHints]]);

    const ev = await buildConversationSummaryEvent(db, { conversationId: 'conv-1' });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.kind).toBe('conversation_summary');
    expect(ev.action).toBe('update');
    expect(ev.event_id).toBe('conv_conv-1:resolved');
    expect(ev.participants).toHaveLength(2);
  });

  it('handoff_to_human — valid envelope + timestamped event_id', async () => {
    const db = makeDb([[convRow], [inboxRow], [contactHints], [userHints]]);

    const ev = await buildHandoffEvent(db, { conversationId: 'conv-1' });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.kind).toBe('handoff_to_human');
    expect(ev.action).toBe('update');
    expect(ev.event_id).toMatch(/^conv_conv-1:handoff:\d+$/);
  });

  it('contact — valid envelope + email/phone hints', async () => {
    const contactRow = {
      id: 'contact-1',
      accountId: 'account-1',
      name: 'João',
      email: 'joao@example.com',
      phone: '+5511999999999',
      createdAt: new Date('2026-05-01T09:00:00Z'),
    };
    const db = makeDb([[contactRow]]);

    const ev = await buildContactEvent(db, { contactId: 'contact-1' });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.kind).toBe('contact');
    expect(ev.event_id).toBe('contact_contact-1');
    expect(ev.actors[0]?.role).toBe('sender');
    expect(ev.actors[0]?.hints?.email).toBe('joao@example.com');
    expect(ev.actors[0]?.hints?.phone).toBe('+5511999999999');
    expect(ev.metadata).toEqual({ accountId: 'account-1' });
  });

  it('per-account orgId (T-04) — input.orgId overrides config.ATLAS_ORG_ID', async () => {
    const PER_ACCOUNT_ORG = '9c5a1f2e-0000-4000-8000-000000000abc';
    const contactRow = {
      id: 'contact-9',
      accountId: 'account-9',
      name: 'Maria',
      email: 'maria@example.com',
      phone: '+5511888888888',
      createdAt: new Date('2026-05-01T09:00:00Z'),
    };
    const db = makeDb([[contactRow]]);

    const ev = await buildContactEvent(db, { contactId: 'contact-9', orgId: PER_ACCOUNT_ORG });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    // The connection's org wins over the global env fallback.
    expect(ev.org_id).toBe(PER_ACCOUNT_ORG);
  });

  it('per-account orgId (T-04) — falls back to config.ATLAS_ORG_ID when omitted', async () => {
    const contactRow = {
      id: 'contact-8',
      accountId: 'account-8',
      name: 'Ana',
      email: 'ana@example.com',
      phone: '+5511777777777',
      createdAt: new Date('2026-05-01T09:00:00Z'),
    };
    const db = makeDb([[contactRow]]);

    const ev = await buildContactEvent(db, { contactId: 'contact-8' });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    // No per-account orgId → the mocked global config supplies it (compat path
    // for enqueue/worker/backfill until T-05 wires the connection orgId).
    expect(ev.org_id).toBe('220ef5e0-47df-4493-ae4d-ec0dfe83cabd');
  });

  it('resolveActorHints (user) — joins users for email/display_name', async () => {
    const db = makeDb([[userHints]]);

    const actor = await resolveActorHints(db, 'user', 'user-1');

    expect(actor.app_user_id).toBe('user-1');
    expect(actor.hints?.email).toBe('agent@blossom.com');
    expect(actor.hints?.display_name).toBe('Agent Smith');
    // a user actor carries no phone hint.
    expect(actor.hints?.phone).toBeUndefined();
  });
});
