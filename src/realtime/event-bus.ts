import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub for realtime events.
 * For multi-instance deployments this should be backed by Redis pub/sub
 * (see plan §12.2 — deferred to a future task).
 */

export type RealtimeEvent =
  | {
      type: 'message.created';
      inboxId: string;
      conversationId: string;
      message: RealtimeMessage;
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
    }
  | {
      type: 'conversation.resolved';
      inboxId: string;
      conversationId: string;
      resolvedBy: string | null;
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
  isPrivateNote: boolean;
  createdAt: Date;
}

export interface RealtimeConversation {
  id: string;
  inboxId: string;
  contactId: string;
  status: string;
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
