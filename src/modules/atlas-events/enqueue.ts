import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { QUEUE_NAMES } from '../../queue';
import type { DB } from '@blossom/db';
import { type AtlasConnector, type ConnectorEvent } from '@atlas/connectors';
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
import { getAtlasConnector } from './connector';

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
 *   1. Connector (Phase 12.2) — gated SOLELY on `ATLAS_CONNECTOR_ENABLED` via
 *      `getAtlasConnector` (NOT `USE_PHASE_12_ENVELOPE`, §11 C-A). Builds a
 *      `ConnectorEvent` and `.emit()`s it; queueAdapter uses `jobId=event_id`.
 *   2. Legacy (Phase B / §12.1) — runs while the Phase B secret is set AND
 *      (connector-off, prod today, OR dual-emit soak). Branches on
 *      `USE_PHASE_12_ENVELOPE`. Connector-only (Phase 10) skips it.
 * C1 gate decouple (§11): the subscription survives when EITHER the Phase B
 * secret OR the connector is set — Phase 10 dropping the secret must not kill
 * the connector. Worker.ts (T-007) dispatches the queued shapes.
 */
export function subscribeAtlasEvents(app: FastifyInstance): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET && !config.ATLAS_CONNECTOR_ENABLED) {
    app.log.info('atlas-events: disabled (no HMAC secret, connector off)');
    return;
  }

  const connector = getAtlasConnector(app);
  const queue = app.queues.getQueue<AtlasEventJob>(QUEUE_NAMES.ATLAS_EVENTS);

  // Phase B leg runs when its secret is set AND (connector-off OR dual-emit).
  const runLegacy =
    !!config.ATLAS_EVENTS_HMAC_SECRET &&
    (!config.ATLAS_CONNECTOR_ENABLED || config.ATLAS_DUAL_EMIT);

  eventBus.onEvent(async (event: RealtimeEvent) => {
    if (connector) {
      try {
        await emitConnectorEvent(app.db, connector, event);
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
 * Build the connector envelope for an event and `.emit()` it — unless it
 * belongs to another account. Anti-leak P0 (spec §10b, L-615): the connector
 * maps a SINGLE axis-back account to the Atlas org, so an event whose resolved
 * account differs from `ATLAS_SOURCE_ACCOUNT_ID` must never be stamped with the
 * connector org_id. We drop AFTER building (the builder resolves the account
 * from the inbox/contact row into `metadata.accountId`) but BEFORE emit.
 */
async function emitConnectorEvent(
  db: DB,
  connector: AtlasConnector,
  event: RealtimeEvent,
): Promise<void> {
  const built = await buildConnectorEventForEvent(db, event);
  if (!built) return;
  if (built.metadata['accountId'] !== config.ATLAS_SOURCE_ACCOUNT_ID) return;
  await connector.emit(built);
}

async function buildConnectorEventForEvent(
  db: DB,
  event: RealtimeEvent,
): Promise<ConnectorEvent | null> {
  if (event.type === 'message.created') {
    // Forward the MCP-write `meta` so bot/system turns carry `atlas_user_id`
    // hints (chain of custody, L-604).
    return buildConversationTurnEvent(db, {
      conversationId: event.conversationId,
      messageId: event.message.id,
      meta: event.meta,
    });
  }

  if (event.type === 'conversation.resolved') {
    return buildConversationSummaryEvent(db, { conversationId: event.conversationId });
  }

  if (event.type === 'conversation.assigned') {
    if (event.assignedBotId !== null) return null;
    return buildHandoffEvent(db, { conversationId: event.conversationId });
  }

  if (event.type === 'contact.created') {
    return buildContactEvent(db, { contactId: event.contact.id });
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
