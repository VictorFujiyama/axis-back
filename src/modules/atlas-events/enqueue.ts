import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { QUEUE_NAMES } from '../../queue';
import type { DB } from '@blossom/db';
import {
  buildConversationTurnEnvelope,
  buildHandoffEnvelope,
  buildResolvedEnvelope,
  type AtlasEventEnvelope,
} from './build-envelope';

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
 * Subscribe to eventBus and enqueue outbound Atlas events.
 *
 * Pre-check: ATLAS_EVENTS_HMAC_SECRET unset → feature off, no subscription.
 * Three hooks: message.created, conversation.assigned (filtered to
 * assignedBotId === null), conversation.resolved.
 *
 * Branches on `config.USE_PHASE_12_ENVELOPE`:
 *   true  → Phase 12 §12.1 `kind`-discriminator envelope via build-envelope helpers.
 *   false → Phase B `type`-discriminator literal mapping (verbatim from db7785c0~1)
 *           so Atlas-side `/api/messaging/events` receiver in prod still parses jobs
 *           until the Phase 12 connector receiver lands (see L-420, L-506).
 * Worker.ts narrows on `'kind' in job` to dispatch both shapes.
 */
export function subscribeAtlasEvents(app: FastifyInstance): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET) {
    app.log.info('atlas-events: disabled (no HMAC secret)');
    return;
  }

  const queue = app.queues.getQueue<AtlasEventJob>(QUEUE_NAMES.ATLAS_EVENTS);

  eventBus.onEvent(async (event: RealtimeEvent) => {
    try {
      if (config.USE_PHASE_12_ENVELOPE) {
        const envelope = await buildEnvelopeForEvent(app.db, event);
        if (!envelope) return;
        await queue.add(envelope.kind, envelope, { jobId: envelope.sourceRef });
      } else {
        const mapped = mapLegacyEvent(event);
        if (!mapped) return;
        await queue.add(mapped.payload.type, mapped.payload, { jobId: mapped.jobId });
      }
    } catch (err) {
      app.log.warn({ err, eventType: event.type }, 'atlas-events: enqueue failed');
    }
  });
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
