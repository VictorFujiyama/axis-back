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
 *   1. Connector (Phase 12.2) — gated on `ATLAS_CONNECTOR_ENABLED`, but now
 *      resolves a connector PER ACCOUNT (spec G5, Connect Flow): the event's
 *      axis account → its `atlas_connections` row → `.emit()` stamped with that
 *      connection's org/secret. An account with NO connection never emits
 *      (anti-leak is implicit, no global `ATLAS_SOURCE_ACCOUNT_ID`). queueAdapter
 *      uses `jobId=event_id`. (T-10 swaps the `ATLAS_CONNECTOR_ENABLED` gate for
 *      the per-account/`ATLAS_URL` model once the global env is removed.)
 *   2. Legacy (Phase B / §12.1) — runs while the Phase B secret is set AND
 *      (connector-off, prod today, OR dual-emit soak). Branches on
 *      `USE_PHASE_12_ENVELOPE`. Connector-only (Phase 10) skips it.
 * C1 gate decouple (§11): the subscription survives when EITHER the Phase B
 * secret OR the connector is set — Phase 10 dropping the secret must not kill
 * the connector. Worker.ts dispatches the queued shapes.
 */
export function subscribeAtlasEvents(app: FastifyInstance): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET && !config.ATLAS_CONNECTOR_ENABLED) {
    app.log.info('atlas-events: disabled (no HMAC secret, connector off)');
    return;
  }

  const connectorEnabled = config.ATLAS_CONNECTOR_ENABLED;
  const queue = app.queues.getQueue<AtlasEventJob>(QUEUE_NAMES.ATLAS_EVENTS);

  // Phase B leg runs when its secret is set AND (connector-off OR dual-emit).
  const runLegacy =
    !!config.ATLAS_EVENTS_HMAC_SECRET &&
    (!config.ATLAS_CONNECTOR_ENABLED || config.ATLAS_DUAL_EMIT);

  eventBus.onEvent(async (event: RealtimeEvent) => {
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

  const built = await buildConnectorEventForEvent(app.db, event, conn.atlasOrgId);
  if (!built) return;
  await connector.emit(built);
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
    event.type === 'conversation.assigned'
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
): Promise<ConnectorEvent | null> {
  if (event.type === 'message.created') {
    // Forward the MCP-write `meta` so bot/system turns carry `atlas_user_id`
    // hints (chain of custody, L-604).
    return buildConversationTurnEvent(db, {
      conversationId: event.conversationId,
      messageId: event.message.id,
      meta: event.meta,
      orgId,
    });
  }

  if (event.type === 'conversation.resolved') {
    return buildConversationSummaryEvent(db, { conversationId: event.conversationId, orgId });
  }

  if (event.type === 'conversation.assigned') {
    if (event.assignedBotId !== null) return null;
    return buildHandoffEvent(db, { conversationId: event.conversationId, orgId });
  }

  if (event.type === 'contact.created') {
    return buildContactEvent(db, { contactId: event.contact.id, orgId });
  }

  return null;
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
