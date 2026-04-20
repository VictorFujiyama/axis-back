/**
 * Fallback handler: when a bot fails after all retries, unassign the bot,
 * move the conversation to 'pending' for human pickup, and create a
 * private note explaining what happened.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema, type DB } from '@blossom/db';
import { eventBus } from '../../realtime/event-bus';

export interface FallbackInput {
  conversationId: string;
  botId: string;
  accountId: string;
  reason: 'timeout' | 'max_retries' | 'bot_disabled' | 'webhook_error';
  error?: string;
}

interface FallbackDeps {
  db: DB;
  log: FastifyBaseLogger;
}

export async function handleBotFallback(
  input: FallbackInput,
  { db, log }: FallbackDeps,
): Promise<void> {
  const now = new Date();

  // Only act if the bot is still the owner (optimistic concurrency).
  const [conv] = await db
    .update(schema.conversations)
    .set({
      assignedBotId: null,
      status: 'pending',
      waitingForAgentSince: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.conversations.id, input.conversationId),
        eq(schema.conversations.assignedBotId, input.botId),
      ),
    )
    .returning({
      id: schema.conversations.id,
      inboxId: schema.conversations.inboxId,
    });

  if (!conv) return; // bot was already unassigned — nothing to do

  // Private note alerting agents
  const reasonLabels: Record<FallbackInput['reason'], string> = {
    timeout: 'Timeout — bot não respondeu a tempo',
    max_retries: 'Falha após múltiplas tentativas',
    bot_disabled: 'Bot desabilitado',
    webhook_error: 'Erro no webhook do bot',
  };
  await db.insert(schema.messages).values({
    conversationId: input.conversationId,
    inboxId: conv.inboxId,
    senderType: 'system',
    content: `⚠️ Bot falhou (${reasonLabels[input.reason]}). Conversa encaminhada para atendimento humano.`,
    isPrivateNote: true,
  });

  // Log in bot_events
  await db
    .insert(schema.botEvents)
    .values({
      botId: input.botId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      event: 'fallback',
      direction: 'outbound',
      status: 'failed',
      error: input.error ?? input.reason,
    })
    .catch((err) => log.warn({ err }, 'bot_events fallback insert failed'));

  // Notify agents via WebSocket
  eventBus.emitEvent({
    type: 'conversation.assigned',
    inboxId: conv.inboxId,
    conversationId: input.conversationId,
    assignedUserId: null,
    assignedTeamId: null,
    assignedBotId: null,
  });

  log.warn({ ...input }, 'bot: fallback triggered — conversation unassigned from bot');
}
