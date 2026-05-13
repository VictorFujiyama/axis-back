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
