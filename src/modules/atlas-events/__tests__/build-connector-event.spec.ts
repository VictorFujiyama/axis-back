import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@blossom/db';
import { parseConnectorEvent } from '@atlas/connectors';

// build-connector-event no longer reads `config.ATLAS_ORG_ID` (Connect Flow
// T-10 removed the global fallback): each builder threads the connection's
// `orgId` in, and omitting it yields org_id '' which fails validation loudly.

import {
  buildContactEvent,
  buildConversationSummaryEvent,
  buildConversationTurnEvent,
  buildHandoffEvent,
  buildLeadQualifiedEnvelope,
  resolveActorHints,
} from '../build-connector-event';
import { LEAD_QUALIFIED_KIND } from '../lead-qualified';

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
// Per-account org id threaded into each builder (Connect Flow T-10 — there is no
// global config.ATLAS_ORG_ID fallback; the caller always supplies it).
const TEST_ORG_ID = '220ef5e0-47df-4493-ae4d-ec0dfe83cabd';

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
      orgId: TEST_ORG_ID,
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
    // T-16: metadata carries inboxId + senderType for Atlas qualifier-agent gating.
    expect(ev.metadata).toEqual({ accountId: 'account-1', inboxId: 'inbox-1', senderType: 'contact' });
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
      orgId: TEST_ORG_ID,
    });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.actors[0]?.role).toBe('sender');
    expect(ev.actors[0]?.app_user_id).toBe('bot-axis-1');
    expect(ev.actors[0]?.hints?.atlas_user_id).toBe('user_clerk_atlas_999');
    // bot/system turns skip the embed budget (spec §12.1.06).
    expect(ev.embedding_text).toBeNull();
    // T-16: bot senderType lets the Atlas worker skip the qualifier-agent enqueue.
    expect(ev.metadata).toEqual({ accountId: 'account-1', inboxId: 'inbox-1', senderType: 'bot' });
  });

  it('conversation_summary — valid envelope + resolved event_id', async () => {
    const db = makeDb([[convRow], [inboxRow], [contactHints], [userHints]]);

    const ev = await buildConversationSummaryEvent(db, { conversationId: 'conv-1', orgId: TEST_ORG_ID });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.kind).toBe('conversation_summary');
    expect(ev.action).toBe('update');
    expect(ev.event_id).toBe('conv_conv-1:resolved');
    expect(ev.participants).toHaveLength(2);
  });

  it('handoff_to_human — valid envelope + timestamped event_id', async () => {
    const db = makeDb([[convRow], [inboxRow], [contactHints], [userHints]]);

    const ev = await buildHandoffEvent(db, { conversationId: 'conv-1', orgId: TEST_ORG_ID });

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

    const ev = await buildContactEvent(db, { contactId: 'contact-1', orgId: TEST_ORG_ID });

    expect(parseConnectorEvent(ev).ok).toBe(true);
    expect(ev.kind).toBe('contact');
    expect(ev.event_id).toBe('contact_contact-1');
    expect(ev.actors[0]?.role).toBe('sender');
    expect(ev.actors[0]?.hints?.email).toBe('joao@example.com');
    expect(ev.actors[0]?.hints?.phone).toBe('+5511999999999');
    expect(ev.metadata).toEqual({ accountId: 'account-1' });
  });

  it('per-account orgId (Connect Flow) — input.orgId is stamped on the envelope', async () => {
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
    // The connection's org is stamped on the envelope's org_id.
    expect(ev.org_id).toBe(PER_ACCOUNT_ORG);
  });

  it('per-account orgId (Connect Flow) — omitting orgId yields org_id "" and fails validation', async () => {
    const contactRow = {
      id: 'contact-8',
      accountId: 'account-8',
      name: 'Ana',
      email: 'ana@example.com',
      phone: '+5511777777777',
      createdAt: new Date('2026-05-01T09:00:00Z'),
    };
    const db = makeDb([[contactRow]]);

    // No per-account orgId and no global fallback (T-10 removed config.ATLAS_ORG_ID)
    // → org_id falls to '' and validateConnectorEvent throws loudly rather than
    // shipping a malformed envelope.
    await expect(buildContactEvent(db, { contactId: 'contact-8' })).rejects.toThrow();
  });

  describe('lead_qualified envelope (T-02)', () => {
    // The builder runs four queries in order: loadConversation, contact (mine,
    // for typed payload + hints), contact-participant, user-participant. Each
    // test seeds rowSets matching that fixed order.
    const TAGGED_AT = '2026-05-29T13:00:00.000Z';
    const TAGGED_AT_MS = Date.parse(TAGGED_AT);

    it('contact with phone only — payload omits email, hints carry null email', async () => {
      const contactRow = {
        id: 'contact-1',
        name: 'João',
        email: null,
        phone: '+5511999999999',
      };
      const db = makeDb([[convRow], [contactRow], [contactHints], [userHints]]);

      const ev = await buildLeadQualifiedEnvelope(db, {
        conversationId: 'conv-1',
        accountId: 'account-1',
        orgId: TEST_ORG_ID,
        taggedAt: TAGGED_AT,
      });

      expect(parseConnectorEvent(ev).ok).toBe(true);
      expect(ev.kind).toBe(LEAD_QUALIFIED_KIND);
      expect(ev.action).toBe('create');
      expect(ev.event_id).toBe(`conv_conv-1:lead_qualified:${TAGGED_AT_MS}`);
      expect(ev.source_ref).toEqual({ id: 'conv-1' });
      expect(ev.summary).toBe('Lead qualified: João');
      // payload is parked under metadata.lead_qualified (envelope kind is open string).
      const payload = (ev.metadata as Record<string, unknown>)['lead_qualified'] as Record<
        string,
        unknown
      >;
      expect(payload).toBeDefined();
      expect(payload['contact']).toEqual({ name: 'João', phone: '+5511999999999' });
      expect(payload['source_ref']).toBe('conv-1');
      expect(payload['tagged_at']).toBe(TAGGED_AT);
      expect(payload['conv_summary']).toBeUndefined();
      // actor hints mirror the typed contact — null for the missing channel so
      // the Atlas-side dedup doesn't re-read the source.
      expect(ev.actors[0]?.hints?.phone).toBe('+5511999999999');
      expect(ev.actors[0]?.hints?.email).toBeNull();
      expect(ev.metadata['accountId']).toBe('account-1');
    });

    it('contact with email only — payload omits phone, identity hints fall through to email', async () => {
      const contactRow = {
        id: 'contact-2',
        name: null,
        email: 'maria@example.com',
        phone: null,
      };
      const db = makeDb([[convRow], [contactRow], [contactHints], [userHints]]);

      const ev = await buildLeadQualifiedEnvelope(db, {
        conversationId: 'conv-1',
        accountId: 'account-1',
        orgId: TEST_ORG_ID,
        taggedAt: TAGGED_AT,
      });

      expect(parseConnectorEvent(ev).ok).toBe(true);
      // No name and no phone — summary falls through to email.
      expect(ev.summary).toBe('Lead qualified: maria@example.com');
      const payload = (ev.metadata as Record<string, unknown>)['lead_qualified'] as Record<
        string,
        unknown
      >;
      expect(payload['contact']).toEqual({ email: 'maria@example.com' });
    });

    it('contact with both phone and email — payload carries both, conv_summary forwarded', async () => {
      const contactRow = {
        id: 'contact-3',
        name: 'Ana',
        email: 'ana@example.com',
        phone: '+5511777777777',
      };
      const db = makeDb([[convRow], [contactRow], [contactHints], [userHints]]);

      const ev = await buildLeadQualifiedEnvelope(db, {
        conversationId: 'conv-1',
        accountId: 'account-1',
        orgId: TEST_ORG_ID,
        taggedAt: TAGGED_AT,
        convSummary: 'Asked about pricing, asked when we can start.',
      });

      expect(parseConnectorEvent(ev).ok).toBe(true);
      const payload = (ev.metadata as Record<string, unknown>)['lead_qualified'] as Record<
        string,
        unknown
      >;
      expect(payload['contact']).toEqual({
        name: 'Ana',
        phone: '+5511777777777',
        email: 'ana@example.com',
      });
      expect(payload['conv_summary']).toBe('Asked about pricing, asked when we can start.');
      // participants come from the conv (contact + assigned user) so the
      // Atlas-side handler can reuse identity-federation without re-querying.
      expect(ev.participants).toHaveLength(2);
    });

    it('omitting taggedAt — defaults to now, envelope still parses', async () => {
      const contactRow = {
        id: 'contact-4',
        name: 'Carla',
        email: null,
        phone: '+5511666666666',
      };
      const db = makeDb([[convRow], [contactRow], [contactHints], [userHints]]);

      const before = Date.now();
      const ev = await buildLeadQualifiedEnvelope(db, {
        conversationId: 'conv-1',
        accountId: 'account-1',
        orgId: TEST_ORG_ID,
      });
      const after = Date.now();

      expect(parseConnectorEvent(ev).ok).toBe(true);
      const payload = (ev.metadata as Record<string, unknown>)['lead_qualified'] as Record<
        string,
        unknown
      >;
      const taggedAtMs = Date.parse(payload['tagged_at'] as string);
      expect(taggedAtMs).toBeGreaterThanOrEqual(before);
      expect(taggedAtMs).toBeLessThanOrEqual(after);
    });
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
