import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import { parseConnectorEvent, type ConnectorEvent } from '@atlas/connectors';
import {
  LEAD_QUALIFIED_KIND,
  parseLeadQualifiedPayload,
  type LeadQualifiedContact,
} from './lead-qualified';
import {
  CONVERSATION_TAGGED_KIND,
  parseConversationTaggedPayload,
  type ConversationTaggedActor,
} from './conversation-tagged';

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

/** Common envelope fields every kind shares. `org_id` comes from the per-account
 * connection (Connect Flow): each builder threads the connection's `orgId` down
 * to here. With no `orgId` the value falls to `''`, which fails
 * `validateConnectorEvent`'s uuid check loudly rather than shipping a malformed
 * envelope (the global `config.ATLAS_ORG_ID` fallback was retired in T-10). */
function connectorBase(
  occurredAt: string,
  orgId?: string,
): Pick<
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
    org_id: orgId ?? '',
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
  input: { conversationId: string; messageId: string; meta?: AtlasMeta; orgId?: string },
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
    ...connectorBase(msg.createdAt.toISOString(), input.orgId),
    event_id: `msg_${msg.id}`,
    kind: 'conversation_turn',
    action: 'create',
    source_ref: { id: msg.id, parent_id: conv.id },
    actors,
    participants: await buildParticipants(db, conv),
    summary: `${senderType}: ${content}`.slice(0, SUMMARY_CAP),
    embedding_text: isLowValue ? null : undefined,
    // `inboxId` + `senderType` ride the metadata so the Atlas worker (T-16)
    // can gate `qualifier-agent` enqueue on (a) inbox has playbook, (b) the
    // turn is from the customer — without re-querying axis-back state.
    metadata: { accountId, inboxId: conv.inboxId, senderType },
  });
}

/** `conversation_summary` — thread resolved. Promotable (curator decides
 * durable memory). `event_id=conv_<id>:resolved` (L-603). */
export async function buildConversationSummaryEvent(
  db: DB,
  input: { conversationId: string; orgId?: string },
): Promise<ConnectorEvent> {
  const conv = await loadConversation(db, input.conversationId);
  const accountId = await loadAccountId(db, conv.inboxId);

  return validateConnectorEvent({
    ...connectorBase(new Date().toISOString(), input.orgId),
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
  input: { conversationId: string; orgId?: string },
): Promise<ConnectorEvent> {
  const conv = await loadConversation(db, input.conversationId);
  const accountId = await loadAccountId(db, conv.inboxId);
  const now = new Date().toISOString();

  return validateConnectorEvent({
    ...connectorBase(now, input.orgId),
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

/** `lead_qualified` — the inbox tagged a conversation as a qualified lead. The
 * typed payload (LeadQualifiedPayloadSchema) is parked in `metadata.lead_qualified`
 * because the connector envelope has no first-class slot for kind-specific
 * payloads (`kind` is open string, `metadata` is free-form JSONB — spec
 * §12.1.01). The Atlas-side handler (T-04/T-05) reads it from there.
 *
 * `event_id=conv_<id>:lead_qualified:<taggedAt_ms>` — keyed on the qualifying
 * timestamp so re-tagging the same conversation at a later time legitimately
 * yields a new event (D6 re-engagement), while a replay of the same envelope
 * dedupes on `(source_app, event_id)`. The caller (T-03 trigger) threads a
 * stable `taggedAt` from the tag row's `createdAt` so retries collapse.
 *
 * Identity hints: name/phone/email on the contact actor mirror the typed
 * payload's `contact` so the Atlas-side dedup (phone → email per D4) doesn't
 * need to re-read the source. Either-or identity is allowed at the envelope
 * level — the handler enforces D4 "no phone and no email → skip materialize". */
export async function buildLeadQualifiedEnvelope(
  db: DB,
  input: {
    conversationId: string;
    accountId: string;
    orgId: string;
    /** ISO 8601 with offset. Defaults to now; T-03 trigger threads the tag's createdAt. */
    taggedAt?: string;
    /** Optional running summary at qualify time. Capped to SUMMARY_CAP downstream. */
    convSummary?: string;
  },
): Promise<ConnectorEvent> {
  const taggedAt = input.taggedAt ?? new Date().toISOString();
  const conv = await loadConversation(db, input.conversationId);

  const [c] = await db
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, conv.contactId))
    .limit(1);
  if (!c) throw new Error(`build-connector-event: contact ${conv.contactId} not found`);

  const contact: LeadQualifiedContact = {};
  if (c.name) contact.name = c.name;
  if (c.phone) contact.phone = c.phone;
  if (c.email) contact.email = c.email;

  const payloadResult = parseLeadQualifiedPayload({
    contact,
    source_ref: conv.id,
    ...(input.convSummary ? { conv_summary: input.convSummary.slice(0, SUMMARY_CAP) } : {}),
    tagged_at: taggedAt,
  });
  if (!payloadResult.ok) {
    throw new Error(
      `build-connector-event: invalid lead_qualified payload: ${JSON.stringify(payloadResult.error.issues)}`,
    );
  }

  const display = c.name ?? c.phone ?? c.email ?? 'Unnamed contact';

  return validateConnectorEvent({
    ...connectorBase(taggedAt, input.orgId),
    event_id: `conv_${conv.id}:lead_qualified:${Date.parse(taggedAt)}`,
    kind: LEAD_QUALIFIED_KIND,
    action: 'create',
    source_ref: { id: conv.id },
    actors: [
      {
        app_user_id: c.id,
        role: 'sender',
        hints: { email: c.email ?? null, phone: c.phone ?? null, display_name: c.name ?? null },
      },
    ],
    participants: await buildParticipants(db, conv),
    summary: `Lead qualified: ${display}`.slice(0, SUMMARY_CAP),
    metadata: {
      accountId: input.accountId,
      lead_qualified: payloadResult.payload,
    },
  });
}

/** `conversation_tagged` — a tag (ANY name) was applied to a conversation. The
 * generic sibling of `lead_qualified` (D20). Emitted for EVERY tag so Atlas-side
 * journey triggers (Task 6.4) can match arbitrary tags; for the `qualified` tag
 * it is emitted in PARALLEL with `lead_qualified` (which stays for the CRM
 * handler's BC), never replacing it.
 *
 * `event_id=conv_<id>:tagged:<tagId>:<taggedAt_ms>` — keyed on (tag, timestamp)
 * so re-tagging legitimately yields a new event while a replay dedupes on
 * `(source_app, event_id)`. The typed payload (ConversationTaggedPayloadSchema)
 * is parked under `metadata.conversation_tagged` because the envelope `kind` is
 * an open string and `metadata` is free-form (spec §12.1.01) — the Atlas-side
 * trigger matcher reads it from there.
 *
 * Participants carry the contact + assigned user (identity-federation hints) so
 * the Atlas-side `resolve-contact` doesn't re-read the source. `actors` is empty
 * — the realtime event does not carry the tagging actor yet (payload `actor`
 * defaults to null). */
export async function buildConversationTaggedEnvelope(
  db: DB,
  input: {
    conversationId: string;
    tagId: string;
    tagName: string;
    accountId: string;
    orgId: string;
    /** ISO 8601 with offset. Defaults to now; the trigger threads the tag's createdAt. */
    taggedAt?: string;
    /** Who applied the tag, when known (the realtime event does not carry it yet). */
    actor?: ConversationTaggedActor | null;
  },
): Promise<ConnectorEvent> {
  const taggedAt = input.taggedAt ?? new Date().toISOString();
  const conv = await loadConversation(db, input.conversationId);

  const payloadResult = parseConversationTaggedPayload({
    tagName: input.tagName,
    conversationId: conv.id,
    contactId: conv.contactId,
    taggedAt,
    actor: input.actor ?? null,
  });
  if (!payloadResult.ok) {
    throw new Error(
      `build-connector-event: invalid conversation_tagged payload: ${JSON.stringify(payloadResult.error.issues)}`,
    );
  }

  return validateConnectorEvent({
    ...connectorBase(taggedAt, input.orgId),
    event_id: `conv_${conv.id}:tagged:${input.tagId}:${Date.parse(taggedAt)}`,
    kind: CONVERSATION_TAGGED_KIND,
    action: 'create',
    source_ref: { id: conv.id },
    actors: [],
    participants: await buildParticipants(db, conv),
    summary: `Tagged: ${input.tagName}`.slice(0, SUMMARY_CAP),
    metadata: {
      accountId: input.accountId,
      conversation_tagged: payloadResult.payload,
    },
  });
}

/** `contact` — a CRM contact created/updated. `event_id=contact_<id>` (L-603).
 * Emitted before any turn that references the contact so identity resolves to
 * one entity (L-605, spec §12.10.06). */
export async function buildContactEvent(
  db: DB,
  input: { contactId: string; orgId?: string },
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
    ...connectorBase(c.createdAt.toISOString(), input.orgId),
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
