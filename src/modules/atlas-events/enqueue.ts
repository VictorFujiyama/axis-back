import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type DB } from '@blossom/db';
import { config } from '../../config';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { QUEUE_NAMES } from '../../queue';
import { type ConnectorEvent } from '@atlas/connectors';
import {
  buildConversationTurnEnvelope,
  buildHandoffEnvelope,
  buildResolvedEnvelope,
  type AtlasEventEnvelope,
} from './build-envelope';
import {
  buildConversationTurnEvent,
  buildConversationSummaryEvent,
  buildHandoffEvent,
  buildContactEvent,
  buildLeadQualifiedEnvelope,
  buildConversationTaggedEnvelope,
  buildMessageFailedEnvelope,
} from './build-connector-event';
import { getConnectorForAccount } from './connector';
import { getConnection } from './connections';

export interface AtlasEventActor {
  kind: 'contact' | 'user' | 'bot' | 'system';
  id: string;
  appUserId?: string;
}

export interface AtlasEventParticipant {
  kind: 'contact' | 'user' | 'team' | 'bot';
  id: string;
}

export interface AtlasEventViewableBy {
  scope: 'org' | 'users';
  users?: string[];
}

export type AtlasEventJob =
  | {
      kind: 'conversation_turn' | 'conversation_summary' | 'contact';
      action: 'create' | 'update' | 'delete';
      sourceRef: string;
      occurredAt: string;
      summary: string;
      accountId: string;
      actors: AtlasEventActor[];
      participants: AtlasEventParticipant[];
      viewableBy: AtlasEventViewableBy;
      payload?: Record<string, unknown>;
    }
  | {
      type: 'message_sent';
      conversationId: string;
      messageId: string;
      occurredAt: string;
      summary: string;
    }
  | {
      type: 'handoff_to_human';
      conversationId: string;
      assignedUserId: string | null;
      assignedTeamId: string | null;
      occurredAt: string;
      summary: string;
    }
  | {
      type: 'conversation_resolved';
      conversationId: string;
      occurredAt: string;
      summary: string;
    };

type LegacyAtlasEventJob = Extract<AtlasEventJob, { type: string }>;

interface LegacyMappedJob {
  payload: LegacyAtlasEventJob;
  jobId: string;
}

/**
 * Subscribe to eventBus and enqueue outbound Atlas events. Two independent legs
 * run per event (spec §11 flag matrix), each in its own try/catch so one can't
 * block the other:
 *   1. Connector (Phase 12.2) — gated on `ATLAS_URL` (the connector master
 *      switch), resolving a connector PER ACCOUNT (spec G5, Connect Flow): the
 *      event's axis account → its `atlas_connections` row → `.emit()` stamped
 *      with that connection's org/secret. An account with NO connection never
 *      emits (anti-leak is implicit, no global `ATLAS_SOURCE_ACCOUNT_ID`).
 *      queueAdapter uses `jobId=event_id`.
 *   2. Legacy (Phase B / §12.1) — runs while the Phase B secret is set AND the
 *      connector is off (no `ATLAS_URL`). Branches on `USE_PHASE_12_ENVELOPE`.
 *      Connector-on (post-Phase 10) skips it — connector-only delivery.
 * C1 gate decouple (§11): the subscription survives when EITHER the Phase B
 * secret OR the connector is set — Phase 10 dropping the secret must not kill
 * the connector. Worker.ts dispatches the queued shapes.
 */
export function subscribeAtlasEvents(app: FastifyInstance): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET && !config.ATLAS_URL) {
    app.log.info('atlas-events: disabled (no HMAC secret, connector off)');
    return;
  }

  // ATLAS_URL is the connector master switch (Connect Flow T-10): set → the
  // per-account connector leg is live.
  const connectorEnabled = !!config.ATLAS_URL;
  const queue = app.queues.getQueue<AtlasEventJob>(QUEUE_NAMES.ATLAS_EVENTS);

  // Phase B leg runs when its secret is set AND the connector is off — once the
  // connector is on, delivery is connector-only (Phase 10, dual-emit retired).
  const runLegacy = !!config.ATLAS_EVENTS_HMAC_SECRET && !connectorEnabled;

  eventBus.onEvent(async (event: RealtimeEvent) => {
    // [autonomy-T-18] Smart-handoff gate (spec Fase G, D28): a contact's inbound
    // turn is forwarded to Atlas ONLY while the conversation is bot-managed and
    // no human has taken over. Once an operator is assigned (or nobody owns the
    // conversation at all) the qualifier must not see it. Runs ahead of both
    // delivery legs so the skip is leg-agnostic. Non-contact turns (bot/system
    // outbound, MCP writes) are unaffected — they still need to flow for chain
    // of custody.
    if (event.type === 'message.created' && event.message.senderType === 'contact') {
      let skip = false;
      try {
        skip = await skipContactTurnForAssignment(app.db, event.conversationId);
      } catch (err) {
        // Permissive on infra error: a transient read failure must not silently
        // drop a customer turn — fall through and let the builders run/log.
        app.log.warn(
          { err, eventType: event.type },
          'atlas-events: assignment gate read failed (proceeding)',
        );
      }
      if (skip) return;
    }

    if (connectorEnabled) {
      try {
        await emitConnectorEvent(app, event);
      } catch (err) {
        app.log.warn({ err, eventType: event.type }, 'atlas-events: connector emit failed');
      }
    }

    if (!runLegacy) return;
    try {
      if (config.USE_PHASE_12_ENVELOPE) {
        const envelope = await buildEnvelopeForEvent(app.db, event);
        if (envelope) await queue.add(envelope.kind, envelope, { jobId: envelope.sourceRef });
      } else {
        const mapped = mapLegacyEvent(event);
        if (mapped) await queue.add(mapped.payload.type, mapped.payload, { jobId: mapped.jobId });
      }
    } catch (err) {
      app.log.warn({ err, eventType: event.type }, 'atlas-events: enqueue failed');
    }
  });
}

/**
 * Resolve the event's axis account, look up that account's Atlas connection,
 * and `.emit()` the connector event stamped with the connection's `org_id`.
 *
 * Anti-leak is now implicit and per-account (spec G5): only an account that has
 * a row in `atlas_connections` emits — an event whose account has no connection
 * is dropped BEFORE building, with no global `ATLAS_SOURCE_ACCOUNT_ID` compare.
 * The `org_id` stamped on the envelope comes from the connection (threaded into
 * the builder), so each account's events carry that account's org/secret.
 *
 * `getConnection` runs once here for the org + existence check and again inside
 * `getConnectorForAccount` (its rotation-safe cache guard re-reads it) — a cheap
 * extra row read per emit, kept for the clean per-account boundary.
 */
async function emitConnectorEvent(app: FastifyInstance, event: RealtimeEvent): Promise<void> {
  const accountId = await resolveEventAccountId(app.db, event);
  if (!accountId) return;

  const conn = await getConnection(app.db, accountId);
  if (!conn) return; // no connection for this account → never emit (anti-leak)

  const connector = await getConnectorForAccount(app, accountId);
  if (!connector) return; // defensive: connection vanished between the two reads

  // A single source event can fan out into multiple connector events (D20: a
  // `qualified` tag emits BOTH `lead_qualified` and `conversation_tagged`).
  const built = await buildConnectorEventForEvent(app.db, event, conn.atlasOrgId);
  for (const ev of built) await connector.emit(ev);
}

/**
 * [autonomy-T-18] Decide whether a contact's inbound `conversation_turn` must be
 * dropped before reaching Atlas (spec Fase G, D28). The qualifier-agent only
 * owns bot-managed conversations, so a turn is SKIPPED when either:
 *   - a human is assigned (`assignedUserId !== null`) — the operator took over,
 *     and this precedes any bot assignment (the "bizarre" both-set state); or
 *   - nobody owns it (`assignedBotId === null && assignedUserId === null`) — an
 *     unmanaged inbox with no `defaultBotId` and no manual assignment.
 * Only `assignedBotId !== null && assignedUserId === null` proceeds. Returns
 * false (do NOT skip) when the conversation row is missing, leaving the existing
 * builder not-found path to handle it.
 */
async function skipContactTurnForAssignment(db: DB, conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({
      assignedBotId: schema.conversations.assignedBotId,
      assignedUserId: schema.conversations.assignedUserId,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!row) return false;
  return row.assignedBotId === null || row.assignedUserId !== null;
}

/**
 * Resolve the axis `accountId` an event belongs to, without building the full
 * envelope. Account-scoped events (`contact.created`) carry it directly;
 * conversation-scoped events carry `inboxId`, so map inbox → account. Returns
 * null when the event has no connector mapping (e.g. a bot-assigned handoff).
 */
async function resolveEventAccountId(db: DB, event: RealtimeEvent): Promise<string | null> {
  if (event.type === 'contact.created') return event.accountId;
  if (event.type === 'conversation.assigned' && event.assignedBotId !== null) return null;
  if (
    event.type === 'message.created' ||
    event.type === 'conversation.resolved' ||
    event.type === 'conversation.assigned' ||
    event.type === 'conversation.tagged'
  ) {
    const [row] = await db
      .select({ accountId: schema.inboxes.accountId })
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, event.inboxId))
      .limit(1);
    return row?.accountId ?? null;
  }
  return null;
}

async function buildConnectorEventForEvent(
  db: DB,
  event: RealtimeEvent,
  orgId: string,
): Promise<ConnectorEvent[]> {
  if (event.type === 'message.created') {
    // Forward the MCP-write `meta` so bot/system turns carry `atlas_user_id`
    // hints (chain of custody, L-604).
    return [
      await buildConversationTurnEvent(db, {
        conversationId: event.conversationId,
        messageId: event.message.id,
        meta: event.meta,
        orgId,
      }),
    ];
  }

  if (event.type === 'conversation.resolved') {
    return [await buildConversationSummaryEvent(db, { conversationId: event.conversationId, orgId })];
  }

  if (event.type === 'conversation.assigned') {
    if (event.assignedBotId !== null) return [];
    return [await buildHandoffEvent(db, { conversationId: event.conversationId, orgId })];
  }

  if (event.type === 'contact.created') {
    return [await buildContactEvent(db, { contactId: event.contact.id, orgId })];
  }

  // `conversation.tagged` fans out (D20). For EVERY tag with a resolvable
  // account it emits `conversation_tagged` (generic — feeds Atlas journey
  // triggers, Task 6.4). For the `qualified` tag (case-insensitive, D3) it
  // ADDITIONALLY emits `lead_qualified` in parallel (the CRM handler's BC, T-02)
  // — the two coexist, the generic one never replaces it. A vanished tag row or
  // an unmapped inbox drops both.
  if (event.type === 'conversation.tagged') {
    const [tag] = await db
      .select({ name: schema.tags.name })
      .from(schema.tags)
      .where(eq(schema.tags.id, event.tagId))
      .limit(1);
    if (!tag) return [];
    const [inbox] = await db
      .select({ accountId: schema.inboxes.accountId })
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, event.inboxId))
      .limit(1);
    if (!inbox?.accountId) return [];

    const out: ConnectorEvent[] = [];
    // lead_qualified (BC, CRM handler) — only the `qualified` tag (D3).
    if (tag.name.toLowerCase() === 'qualified') {
      out.push(
        await buildLeadQualifiedEnvelope(db, {
          conversationId: event.conversationId,
          accountId: inbox.accountId,
          orgId,
          taggedAt: event.taggedAt,
        }),
      );
    }
    // conversation_tagged (generic, journeys) — every tag (D20), in parallel.
    out.push(
      await buildConversationTaggedEnvelope(db, {
        conversationId: event.conversationId,
        tagId: event.tagId,
        tagName: tag.name,
        accountId: inbox.accountId,
        orgId,
        taggedAt: event.taggedAt,
      }),
    );
    return out;
  }

  return [];
}

async function buildEnvelopeForEvent(
  db: DB,
  event: RealtimeEvent,
): Promise<AtlasEventEnvelope | null> {
  if (event.type === 'message.created') {
    // Forward MCP-write `meta` so `mapActors()` can stamp `actors[].app_user_id`
    // on the outbound envelope (T-021 actor binding propagation, L-403).
    return buildConversationTurnEnvelope(db, {
      conversationId: event.conversationId,
      messageId: event.message.id,
      action: 'create',
      atlasMeta: event.meta,
    });
  }

  if (event.type === 'conversation.assigned') {
    if (event.assignedBotId !== null) return null;
    return buildHandoffEnvelope(db, event);
  }

  if (event.type === 'conversation.resolved') {
    return buildResolvedEnvelope(db, event);
  }

  return null;
}

function mapLegacyEvent(event: RealtimeEvent): LegacyMappedJob | null {
  const occurredAt = new Date().toISOString();

  if (event.type === 'message.created') {
    const content = (event.message.content ?? '').slice(0, 200);
    return {
      payload: {
        type: 'message_sent',
        conversationId: event.conversationId,
        messageId: event.message.id,
        occurredAt,
        summary: `${event.message.senderType}: ${content}`,
      },
      jobId: `${event.conversationId}:message_sent:${event.message.id}`,
    };
  }

  if (event.type === 'conversation.assigned') {
    if (event.assignedBotId !== null) return null;
    const who = event.assignedUserId
      ? 'user'
      : event.assignedTeamId
        ? 'team'
        : 'unassigned';
    return {
      payload: {
        type: 'handoff_to_human',
        conversationId: event.conversationId,
        assignedUserId: event.assignedUserId,
        assignedTeamId: event.assignedTeamId,
        occurredAt,
        summary: `Handoff: bot → ${who}`,
      },
      jobId: `${event.conversationId}:handoff:${Date.parse(occurredAt)}`,
    };
  }

  if (event.type === 'conversation.resolved') {
    return {
      payload: {
        type: 'conversation_resolved',
        conversationId: event.conversationId,
        occurredAt,
        summary: 'Resolved',
      },
      jobId: `${event.conversationId}:resolved`,
    };
  }

  return null;
}

/**
 * [marketing-T-09] Emit a `message.failed` connector event when an outbound send
 * permanently fails (spec D11). Unlike the five eventBus-driven envelopes, this
 * one is emitted imperatively from the failure site (worker `failed` handler in
 * T-09, sender permanent-fail paths in T-10) — there is no RealtimeEvent for a
 * send failure. It still rides the SAME per-account connector pipeline as the
 * others (resolve account → connection → connector → `.emit()`), so anti-leak
 * (only accounts WITH a connection emit) and idempotency (`event_id`) hold.
 *
 * Fail-open: the whole body is wrapped — a missing connection, an unset
 * `ATLAS_URL`, or an emit error must never bubble back into the worker's
 * `failed` handler (the message is ALREADY marked failed; a bounce-notify miss
 * is recoverable, a thrown error in the handler is not). Logs warn and returns.
 */
export async function emitMessageFailed(
  app: FastifyInstance,
  params: {
    messageId: string;
    conversationId: string;
    inboxId: string;
    channel: string;
    failureReason: string;
    failedAt: Date;
  },
): Promise<void> {
  // ATLAS_URL is the connector master switch — without it there is no Atlas to
  // emit to (and `getConnectorForAccount` would throw). Quiet no-op when off.
  if (!config.ATLAS_URL) return;

  try {
    const [inbox] = await app.db
      .select({ accountId: schema.inboxes.accountId })
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, params.inboxId))
      .limit(1);
    const accountId = inbox?.accountId;
    if (!accountId) return;

    const conn = await getConnection(app.db, accountId);
    if (!conn) return; // no connection for this account → never emit (anti-leak)

    const connector = await getConnectorForAccount(app, accountId);
    if (!connector) return; // defensive: connection vanished between the two reads

    // Carry the Atlas journey-run origin (D13) when the message was sent by a
    // journey — `upsert_and_send` stamps `atlas_journey_run_id` on the metadata.
    const [msg] = await app.db
      .select({ metadata: schema.messages.metadata })
      .from(schema.messages)
      .where(eq(schema.messages.id, params.messageId))
      .limit(1);
    const meta = (msg?.metadata ?? {}) as Record<string, unknown>;
    const sentByJourneyRunId =
      typeof meta['atlas_journey_run_id'] === 'string'
        ? (meta['atlas_journey_run_id'] as string)
        : undefined;

    const envelope = buildMessageFailedEnvelope({
      orgId: conn.atlasOrgId,
      accountId,
      conversationId: params.conversationId,
      messageId: params.messageId,
      channel: params.channel,
      failureReason: params.failureReason,
      failedAt: params.failedAt,
      ...(sentByJourneyRunId ? { sentByJourneyRunId } : {}),
    });
    await connector.emit(envelope);
  } catch (err) {
    app.log.warn(
      { err, messageId: params.messageId },
      'atlas-events: message.failed emit failed',
    );
  }
}
