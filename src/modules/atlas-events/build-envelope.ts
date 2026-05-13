import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import type { RealtimeEvent } from '../../realtime/event-bus';
import type {
  AtlasEventActor,
  AtlasEventJob,
  AtlasEventParticipant,
  AtlasEventViewableBy,
} from './enqueue';

type SenderType = 'contact' | 'user' | 'bot' | 'system';

export type AtlasEventEnvelope = Extract<AtlasEventJob, { kind: string }>;

export interface AtlasMeta {
  atlasAppUserId?: string;
  atlasOrgId?: string;
}

const SUMMARY_CAP = 200;
const DEFAULT_VIEWABLE: AtlasEventViewableBy = { scope: 'org' };

/**
 * When the MCP write path drives the bot insert, the Atlas requester rides
 * along as `app_user_id` so Atlas-side `shadow_records` keeps the chain of
 * custody (Atlas user → axis bot → wire actor). Phase 12 §12.1 + L-403.
 */
export function mapActors(
  senderType: SenderType,
  senderId: string | null,
  atlasMeta?: AtlasMeta,
): AtlasEventActor[] {
  if (!senderId) return [];
  if (senderType === 'bot' && atlasMeta?.atlasAppUserId) {
    return [{ kind: 'bot', id: senderId, appUserId: atlasMeta.atlasAppUserId }];
  }
  return [{ kind: senderType, id: senderId }];
}

function buildParticipants(opts: {
  contactId: string | null;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  botSenderId?: string | null;
}): AtlasEventParticipant[] {
  const out: AtlasEventParticipant[] = [];
  if (opts.contactId) out.push({ kind: 'contact', id: opts.contactId });
  if (opts.assignedUserId) out.push({ kind: 'user', id: opts.assignedUserId });
  if (opts.assignedTeamId) out.push({ kind: 'team', id: opts.assignedTeamId });
  if (opts.botSenderId && opts.botSenderId !== opts.assignedUserId) {
    out.push({ kind: 'bot', id: opts.botSenderId });
  }
  return out;
}

async function loadConversation(db: DB, conversationId: string) {
  const [row] = await db
    .select({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
      contactId: schema.conversations.contactId,
      assignedUserId: schema.conversations.assignedUserId,
      assignedTeamId: schema.conversations.assignedTeamId,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!row) throw new Error(`build-envelope: conversation ${conversationId} not found`);
  return row;
}

async function loadInbox(db: DB, inboxId: string) {
  const [row] = await db
    .select({ id: schema.inboxes.id, accountId: schema.inboxes.accountId })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, inboxId))
    .limit(1);
  if (!row) throw new Error(`build-envelope: inbox ${inboxId} not found`);
  if (!row.accountId) throw new Error(`build-envelope: inbox ${row.id} missing accountId`);
  return { id: row.id, accountId: row.accountId };
}

async function loadMessage(db: DB, messageId: string) {
  const [row] = await db
    .select({
      id: schema.messages.id,
      conversationId: schema.messages.conversationId,
      senderType: schema.messages.senderType,
      senderId: schema.messages.senderId,
      content: schema.messages.content,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  if (!row) throw new Error(`build-envelope: message ${messageId} not found`);
  return row;
}

export async function buildConversationTurnEnvelope(
  db: DB,
  input: {
    conversationId: string;
    messageId: string;
    action: 'create' | 'update' | 'delete';
    atlasMeta?: AtlasMeta;
  },
): Promise<AtlasEventEnvelope> {
  const conv = await loadConversation(db, input.conversationId);
  const inbox = await loadInbox(db, conv.inboxId);
  const msg = await loadMessage(db, input.messageId);

  const senderType = msg.senderType as SenderType;
  const content = (msg.content ?? '').slice(0, SUMMARY_CAP);
  const summary = `${senderType}: ${content}`.slice(0, SUMMARY_CAP);

  return {
    kind: 'conversation_turn',
    action: input.action,
    sourceRef: `${conv.id}:message_sent:${msg.id}`,
    occurredAt: msg.createdAt.toISOString(),
    summary,
    accountId: inbox.accountId,
    actors: mapActors(senderType, msg.senderId, input.atlasMeta),
    participants: buildParticipants({
      contactId: conv.contactId,
      assignedUserId: conv.assignedUserId,
      assignedTeamId: conv.assignedTeamId,
      botSenderId: senderType === 'bot' ? msg.senderId : null,
    }),
    viewableBy: DEFAULT_VIEWABLE,
    payload: { conversationId: conv.id, messageId: msg.id, inboxId: conv.inboxId },
  };
}

export async function buildHandoffEnvelope(
  db: DB,
  event: Extract<RealtimeEvent, { type: 'conversation.assigned' }>,
): Promise<AtlasEventEnvelope> {
  const conv = await loadConversation(db, event.conversationId);
  const inbox = await loadInbox(db, conv.inboxId);
  const occurredAt = new Date().toISOString();
  const who = event.assignedUserId
    ? 'user'
    : event.assignedTeamId
      ? 'team'
      : 'unassigned';

  return {
    kind: 'conversation_turn',
    action: 'update',
    sourceRef: `${conv.id}:handoff:${Date.parse(occurredAt)}`,
    occurredAt,
    summary: `Handoff: bot → ${who}`.slice(0, SUMMARY_CAP),
    accountId: inbox.accountId,
    actors: [],
    participants: buildParticipants({
      contactId: conv.contactId,
      assignedUserId: event.assignedUserId,
      assignedTeamId: event.assignedTeamId,
    }),
    viewableBy: DEFAULT_VIEWABLE,
    payload: {
      conversationId: conv.id,
      assignedUserId: event.assignedUserId,
      assignedTeamId: event.assignedTeamId,
    },
  };
}

export async function buildResolvedEnvelope(
  db: DB,
  event: Extract<RealtimeEvent, { type: 'conversation.resolved' }>,
): Promise<AtlasEventEnvelope> {
  const conv = await loadConversation(db, event.conversationId);
  const inbox = await loadInbox(db, conv.inboxId);
  const occurredAt = new Date().toISOString();

  return {
    kind: 'conversation_turn',
    action: 'update',
    sourceRef: `${conv.id}:resolved`,
    occurredAt,
    summary: 'Resolved'.slice(0, SUMMARY_CAP),
    accountId: inbox.accountId,
    actors: [],
    participants: buildParticipants({
      contactId: conv.contactId,
      assignedUserId: conv.assignedUserId,
      assignedTeamId: conv.assignedTeamId,
    }),
    viewableBy: DEFAULT_VIEWABLE,
    payload: { conversationId: conv.id, resolvedBy: event.resolvedBy },
  };
}
