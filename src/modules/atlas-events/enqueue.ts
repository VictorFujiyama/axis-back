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

/**
 * Subscribe to eventBus and enqueue outbound Atlas events.
 *
 * Pre-check: ATLAS_EVENTS_HMAC_SECRET unset → feature off, no subscription.
 * Three hooks: message.created, conversation.assigned (filtered to
 * assignedBotId === null), conversation.resolved.
 *
 * Phase D T-004b: emits Phase 12 §12.1 `kind`-discriminator envelopes via
 * `build-envelope` helpers. Phase B `type`-variants remain in {@link AtlasEventJob}
 * so worker can drain in-flight jobs during deploy window.
 */
export function subscribeAtlasEvents(app: FastifyInstance): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET) {
    app.log.info('atlas-events: disabled (no HMAC secret)');
    return;
  }

  const queue = app.queues.getQueue<AtlasEventJob>(QUEUE_NAMES.ATLAS_EVENTS);

  eventBus.onEvent(async (event: RealtimeEvent) => {
    try {
      const envelope = await buildEnvelopeForEvent(app.db, event);
      if (!envelope) return;
      await queue.add(envelope.kind, envelope, { jobId: envelope.sourceRef });
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
    return buildConversationTurnEnvelope(db, {
      conversationId: event.conversationId,
      messageId: event.message.id,
      action: 'create',
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
