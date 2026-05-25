import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import { parseConnectorEvent, type ConnectorEvent } from '@atlas/connectors';
import { config } from '../../config';

/**
 * Phase 12.2 Connector Bridge — `ConnectorEvent` builders (the cutover wire
 * shape, `@atlas/connectors`). These supersede the §12.1 helpers in
 * `build-envelope.ts`; that legacy file stays until enqueue.ts (T-006) and
 * worker.ts (T-007) retire the `USE_PHASE_12_ENVELOPE` branch that still
 * imports it. Kept in a sibling file (not an in-place rewrite) so the old and
 * new shapes coexist during the swap without breaking type-check while T-006
 * is gated on the `contact.created` event (T-008a).
 *
 * Identity federation (L-604): actors + participants carry email/phone/
 * display_name hints so Atlas joins `(app, app_user_id)` to one entity instead
 * of minting a phantom per message. Idempotency (L-603): `event_id` reuses the
 * axis-back record id, so re-emit (backfill, retry, dual-run) is safe.
 */

type SenderType = 'contact' | 'user' | 'bot' | 'system';

export interface AtlasMeta {
  atlasAppUserId?: string;
  atlasOrgId?: string;
}

type ConnectorActor = ConnectorEvent['actors'][number];

const APP_SLUG = 'messaging';
const APP_VERSION = process.env.npm_package_version ?? '0.1.0';
const SCHEMA_VERSION = '1.0';
const SUMMARY_CAP = 500;
const ORG_VIEWABLE: ConnectorEvent['viewable_by'] = { scope: 'org' };

/**
 * `parseConnectorEvent` returns a Result, it never throws (L-612). Wrap loud:
 * an invalid envelope must fail here, not slip silently onto the wire.
 */
function validateConnectorEvent(ev: ConnectorEvent): ConnectorEvent {
  const r = parseConnectorEvent(ev);
  if (!r.ok) {
    throw new Error(
      `build-connector-event: invalid ConnectorEvent: ${JSON.stringify(r.error.issues)}`,
    );
  }
  return r.event;
}

/** Common envelope fields every kind shares. `org_id` is the single Atlas org
 * (L-611); an unset value falls to `''` and fails `validateConnectorEvent`'s
 * uuid check loudly rather than shipping a malformed envelope. */
function connectorBase(occurredAt: string): Pick<
  ConnectorEvent,
  | 'schema_version'
  | 'emitted_at'
  | 'app'
  | 'app_version'
  | 'org_id'
  | 'occurred_at'
  | 'viewable_by'
> {
  return {
    schema_version: SCHEMA_VERSION,
    emitted_at: new Date().toISOString(),
    app: APP_SLUG,
    app_version: APP_VERSION,
    org_id: config.ATLAS_ORG_ID ?? '',
    occurred_at: occurredAt,
    viewable_by: ORG_VIEWABLE,
  };
}

/**
 * Resolve identity-federation hints for one actor (L-604). Partial hints (a
 * contact with no email) are expected — federation degrades, it doesn't break
 * (Berg cutover doc:508). Bot/system actors carry the MCP-write `atlas_user_id`
 * when present so Atlas keeps the chain of custody (Atlas user → axis bot).
 */
export async function resolveActorHints(
  db: DB,
  senderType: SenderType,
  senderId: string,
  atlasMeta?: AtlasMeta,
): Promise<ConnectorActor> {
  if (senderType === 'contact') {
    const [c] = await db
      .select({
        email: schema.contacts.email,
        phone: schema.contacts.phone,
        name: schema.contacts.name,
      })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, senderId))
      .limit(1);
    return {
      app_user_id: senderId,
      hints: { email: c?.email ?? null, phone: c?.phone ?? null, display_name: c?.name ?? null },
    };
  }

  if (senderType === 'user') {
    const [u] = await db
      .select({ email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, senderId))
      .limit(1);
    return {
      app_user_id: senderId,
      hints: { email: u?.email ?? null, display_name: u?.name ?? null },
    };
  }

  const hints: Record<string, unknown> = {
    display_name: senderType === 'bot' ? 'Atlas Assistant' : 'System',
  };
  if (atlasMeta?.atlasAppUserId) hints['atlas_user_id'] = atlasMeta.atlasAppUserId;
  return { app_user_id: senderId, hints };
}

/** Participants of a conversation turn/summary: the contact + the assigned
 * human agent, each with their own federation hints. */
async function buildParticipants(
  db: DB,
  conv: { contactId: string | null; assignedUserId: string | null },
): Promise<ConnectorActor[]> {
  const out: ConnectorActor[] = [];
  if (conv.contactId) out.push(await resolveActorHints(db, 'contact', conv.contactId));
  if (conv.assignedUserId) out.push(await resolveActorHints(db, 'user', conv.assignedUserId));
  return out;
}

async function loadConversation(db: DB, conversationId: string) {
  const [row] = await db
    .select({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      contactId: schema.conversations.contactId,
      assignedUserId: schema.conversations.assignedUserId,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!row) throw new Error(`build-connector-event: conversation ${conversationId} not found`);
  return row;
}

async function loadAccountId(db: DB, inboxId: string): Promise<string> {
  const [row] = await db
    .select({ accountId: schema.inboxes.accountId })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, inboxId))
    .limit(1);
  if (!row) throw new Error(`build-connector-event: inbox ${inboxId} not found`);
  if (!row.accountId) throw new Error(`build-connector-event: inbox ${inboxId} missing accountId`);
  return row.accountId;
}

async function loadMessage(db: DB, messageId: string) {
  const [row] = await db
    .select({
      id: schema.messages.id,
      senderType: schema.messages.senderType,
      senderId: schema.messages.senderId,
      content: schema.messages.content,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  if (!row) throw new Error(`build-connector-event: message ${messageId} not found`);
  return row;
}

/** `conversation_turn` — one WhatsApp message. `event_id=msg_<id>` (L-603).
 * Bot/system turns set `embedding_text: null` to skip the embed budget
 * (low-value, spec §12.1.06); human/contact turns embed their summary. */
export async function buildConversationTurnEvent(
  db: DB,
  input: { conversationId: string; messageId: string; meta?: AtlasMeta },
): Promise<ConnectorEvent> {
  const conv = await loadConversation(db, input.conversationId);
  const accountId = await loadAccountId(db, conv.inboxId);
  const msg = await loadMessage(db, input.messageId);
  const senderType = msg.senderType as SenderType;

  const actors: ConnectorActor[] = msg.senderId
    ? [{ ...(await resolveActorHints(db, senderType, msg.senderId, input.meta)), role: 'sender' }]
    : [];
  const content = (msg.content ?? '').slice(0, SUMMARY_CAP);
  const isLowValue = senderType === 'bot' || senderType === 'system';

  return validateConnectorEvent({
    ...connectorBase(msg.createdAt.toISOString()),
    event_id: `msg_${msg.id}`,
    kind: 'conversation_turn',
    action: 'create',
    source_ref: { id: msg.id, parent_id: conv.id },
    actors,
    participants: await buildParticipants(db, conv),
    summary: `${senderType}: ${content}`.slice(0, SUMMARY_CAP),
    embedding_text: isLowValue ? null : undefined,
    metadata: { accountId },
  });
}

/** `conversation_summary` — thread resolved. Promotable (curator decides
 * durable memory). `event_id=conv_<id>:resolved` (L-603). */
export async function buildConversationSummaryEvent(
  db: DB,
  input: { conversationId: string },
): Promise<ConnectorEvent> {
  const conv = await loadConversation(db, input.conversationId);
  const accountId = await loadAccountId(db, conv.inboxId);

  return validateConnectorEvent({
    ...connectorBase(new Date().toISOString()),
    event_id: `conv_${conv.id}:resolved`,
    kind: 'conversation_summary',
    action: 'update',
    source_ref: { id: conv.id },
    actors: [],
    participants: await buildParticipants(db, conv),
    summary: 'Conversation resolved',
    metadata: { accountId },
  });
}

/** `handoff_to_human` — bot escalated to a human agent. Promotable. A
 * conversation can hand off more than once, so the timestamp keeps each
 * occurrence distinct. */
export async function buildHandoffEvent(
  db: DB,
  input: { conversationId: string },
): Promise<ConnectorEvent> {
  const conv = await loadConversation(db, input.conversationId);
  const accountId = await loadAccountId(db, conv.inboxId);
  const now = new Date().toISOString();

  return validateConnectorEvent({
    ...connectorBase(now),
    event_id: `conv_${conv.id}:handoff:${Date.parse(now)}`,
    kind: 'handoff_to_human',
    action: 'update',
    source_ref: { id: conv.id },
    actors: [],
    participants: await buildParticipants(db, conv),
    summary: 'Bot handed off to a human agent',
    metadata: { accountId },
  });
}

/** `contact` — a CRM contact created/updated. `event_id=contact_<id>` (L-603).
 * Emitted before any turn that references the contact so identity resolves to
 * one entity (L-605, spec §12.10.06). */
export async function buildContactEvent(
  db: DB,
  input: { contactId: string },
): Promise<ConnectorEvent> {
  const [c] = await db
    .select({
      id: schema.contacts.id,
      accountId: schema.contacts.accountId,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      createdAt: schema.contacts.createdAt,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, input.contactId))
    .limit(1);
  if (!c) throw new Error(`build-connector-event: contact ${input.contactId} not found`);
  if (!c.accountId) throw new Error(`build-connector-event: contact ${c.id} missing accountId`);

  return validateConnectorEvent({
    ...connectorBase(c.createdAt.toISOString()),
    event_id: `contact_${c.id}`,
    kind: 'contact',
    action: 'create',
    source_ref: { id: c.id },
    actors: [
      {
        app_user_id: c.id,
        role: 'sender',
        hints: { email: c.email ?? null, phone: c.phone ?? null, display_name: c.name ?? null },
      },
    ],
    participants: [],
    summary: c.name ?? c.phone ?? c.email ?? 'Unnamed contact',
    metadata: { accountId: c.accountId },
  });
}
