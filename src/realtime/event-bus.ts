import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub for realtime events.
 * For multi-instance deployments this should be backed by Redis pub/sub
 * (see plan §12.2 — deferred to a future task).
 */

/**
 * Optional Atlas binding attached to events that originate from the MCP write
 * path (Phase D T-021). Carries the Atlas requester identity through the in-
 * process bus so the atlas-events listener can stamp `actors[].app_user_id`
 * on the outbound envelope (Phase 12 §12.1 + L-403). Non-MCP emitters (Phase
 * A/B/C handlers) leave this undefined — that is correct because those events
 * originate from humans or non-Atlas bots.
 */
export interface RealtimeEventAtlasMeta {
  atlasAppUserId?: string;
  atlasOrgId?: string;
}

export type RealtimeEvent =
  | {
      type: 'message.created';
      inboxId: string;
      conversationId: string;
      message: RealtimeMessage;
      meta?: RealtimeEventAtlasMeta;
    }
  | {
      type: 'conversation.created';
      inboxId: string;
      conversation: RealtimeConversation;
    }
  | {
      type: 'conversation.updated';
      inboxId: string;
      conversationId: string;
      changes: Partial<RealtimeConversation>;
    }
  | {
      type: 'conversation.assigned';
      inboxId: string;
      conversationId: string;
      assignedUserId: string | null;
      assignedTeamId: string | null;
      assignedBotId: string | null;
      meta?: RealtimeEventAtlasMeta;
    }
  | {
      type: 'conversation.resolved';
      inboxId: string;
      conversationId: string;
      resolvedBy: string | null;
      meta?: RealtimeEventAtlasMeta;
    }
  | {
      type: 'conversation.reopened';
      inboxId: string;
      conversationId: string;
    }
  | {
      type: 'message.deleted';
      inboxId: string;
      conversationId: string;
      messageId: string;
    }
  | {
      type: 'message.media-ready';
      inboxId: string;
      conversationId: string;
      messageId: string;
      mediaUrl: string;
      mediaMimeType: string | null;
    }
  | {
      type: 'message.updated';
      inboxId: string;
      conversationId: string;
      messageId: string;
      changes: Partial<{
        deliveredAt: Date | null;
        readAt: Date | null;
        failedAt: Date | null;
        failureReason: string | null;
      }>;
    }
  | {
      type: 'typing.indicator';
      inboxId: string;
      conversationId: string;
      userId: string;
      userName: string;
    }
  | {
      type: 'presence.update';
      accountId: string;
      users: Record<string, 'online' | 'busy' | 'offline'>;
      contacts: Record<string, 'online'>;
    }
  | {
      /**
       * A CRM contact was created or updated. Account-scoped (carries
       * `accountId`, no `inboxId`) so the atlas-events listener can drop events
       * from accounts other than the connector's source account (anti-leak P0,
       * spec §10b). `contact` carries the record the `buildContactEvent` builder
       * keys off (T-006). Realtime sockets drop it — the front has no
       * `contact.created` handler and CRM rows must never leak to widget
       * visitors.
       */
      type: 'contact.created';
      accountId: string;
      contact: RealtimeContact;
    }
  | {
      /**
       * [crm-T-03] A tag was freshly applied to a conversation. Emitted by the
       * 4 in-tree `conversationTags.insert` sites (REST, bulk, automation, bot)
       * AFTER the row truly inserted — noop inserts must not re-fire. The
       * atlas-events listener resolves the tag name and, if `qualified`
       * (case-insensitive, D3), routes to `buildLeadQualifiedEnvelope`; other
       * tag names are no-ops at the connector layer (no envelope is built).
       * Realtime sockets drop this event — front-side tag UI re-reads via REST.
       *
       * `taggedAt` is captured per emit so re-tagging the same conversation
       * after a delete yields a distinct `event_id`
       * (`conv_<id>:lead_qualified:<ms>`), reaching the handler as legitimate
       * re-engagement (D6); replays of the same envelope dedupe on
       * `(source_app, event_id)` at Atlas (T-06).
       */
      type: 'conversation.tagged';
      inboxId: string;
      conversationId: string;
      tagId: string;
      taggedAt: string;
    };

export interface RealtimeMessage {
  id: string;
  conversationId: string;
  inboxId: string;
  senderType: 'contact' | 'user' | 'bot' | 'system';
  senderId: string | null;
  content: string | null;
  contentType: string;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  /**
   * True when an inbound media payload is still being mirrored to our
   * storage in the background. The front should render a skeleton until
   * a `message.media-ready` event arrives with the final URL.
   */
  mediaPending?: boolean;
  isPrivateNote: boolean;
  createdAt: Date;
  sender?: { name: string | null; email?: string };
}

export interface RealtimeConversation {
  id: string;
  inboxId: string;
  contactId: string;
  status: string;
  priority?: string | null;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  assignedBotId: string | null;
  lastMessageAt: Date | null;
  updatedAt: Date;
}

export interface RealtimeContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
}

class TypedEmitter extends EventEmitter {
  emitEvent(event: RealtimeEvent): void {
    this.emit('event', event);
  }
  onEvent(handler: (e: RealtimeEvent) => void): () => void {
    this.on('event', handler);
    return () => this.off('event', handler);
  }
}

export const eventBus = new TypedEmitter();
eventBus.setMaxListeners(0);
