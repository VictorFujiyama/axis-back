import type { FastifyInstance } from 'fastify';
import { config } from '../../config';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { QUEUE_NAMES } from '../../queue';

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
 * Subset of {@link AtlasEventJob} for the Phase B `type`-discriminator variants.
 * T-004b will migrate the listeners below to emit the new `kind`-discriminator
 * envelope; until then `mapEvent` only returns this subtype, which lets the
 * call sites in this file access `.type` / `.conversationId` without narrowing.
 */
type LegacyAtlasEventJob = Extract<AtlasEventJob, { type: string }>;

interface MappedJob {
  payload: LegacyAtlasEventJob;
  jobId: string;
}

/**
 * Subscribe to eventBus and enqueue outbound Atlas events.
 *
 * Pre-check: ATLAS_EVENTS_HMAC_SECRET unset → feature off, no subscription.
 * Three hooks: message.created, conversation.assigned (filtered to
 * assignedBotId === null), conversation.resolved.
 */
export function subscribeAtlasEvents(app: FastifyInstance): void {
  if (!config.ATLAS_EVENTS_HMAC_SECRET) {
    app.log.info('atlas-events: disabled (no HMAC secret)');
    return;
  }

  const queue = app.queues.getQueue<AtlasEventJob>(QUEUE_NAMES.ATLAS_EVENTS);

  eventBus.onEvent(async (event: RealtimeEvent) => {
    try {
      const mapped = mapEvent(event);
      if (!mapped) return;
      await queue.add(mapped.payload.type, mapped.payload, { jobId: mapped.jobId });
    } catch (err) {
      app.log.warn({ err, eventType: event.type }, 'atlas-events: enqueue failed');
    }
  });
}

function mapEvent(event: RealtimeEvent): MappedJob | null {
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
