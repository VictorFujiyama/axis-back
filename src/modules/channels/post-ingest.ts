import { and, eq, gte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { ingestIncomingMessage, type IncomingMessage, type IngestResult } from './helpers';
import {
  type BusinessHoursConfig,
  isWithinBusinessHours,
} from '../sla/compute';
import { eventBus } from '../../realtime/event-bus';
import { getBotQueue } from '../bots/dispatcher';

/**
 * Convenience wrapper used by channel webhooks: run the core ingest, then fire
 * post-ingest hooks (auto-reply out-of-hours, CSAT parse). Hooks never throw.
 */
export async function ingestWithHooks(
  app: FastifyInstance,
  input: IncomingMessage,
  inboxConfig: unknown,
  /** Formal defaultBotId from inbox column (preferred over inboxConfig). */
  defaultBotId?: string | null,
): Promise<IngestResult> {
  const result = await ingestIncomingMessage(input, {
    db: app.db,
    log: app.log,
    inboxConfig,
    defaultBotId,
    botQueue: getBotQueue(app),
    redis: app.redis,
  });

  if (!result.conversationId || !result.messageId || result.deduped || result.blocked) {
    return result;
  }

  // First inbound = conversation has exactly 1 contact-sent message (the one just inserted).
  const contactMsgs = await app.db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, result.conversationId),
        eq(schema.messages.senderType, 'contact'),
      ),
    )
    .limit(2);
  const firstInbound = contactMsgs.length === 1;

  await runPostIngestHooks(result, {
    app,
    inboxId: input.inboxId,
    contactId: result.contactId,
    conversationId: result.conversationId,
    messageContent: input.content,
    inboxConfig,
    isFirstInbound: firstInbound,
  });
  return result;
}

interface PostIngestInput {
  app: FastifyInstance;
  inboxId: string;
  contactId: string;
  conversationId: string;
  messageContent: string;
  inboxConfig: unknown;
  /** True when this message created the conversation — auto-reply only on first inbound. */
  isFirstInbound: boolean;
}

/**
 * Hooks that run AFTER a successful inbound-message ingest:
 *  1. Auto-reply fora de horário (once per conversation)
 *  2. CSAT score parse (when content is a number matching the expected range
 *     and the previous agent action was a resolve within last 24h)
 */
export async function runPostIngestHooks(
  result: IngestResult,
  input: PostIngestInput,
): Promise<void> {
  if (result.deduped || result.blocked || !result.messageId) return;

  await Promise.all([
    maybeSendOutOfHoursReply(input),
    maybeRecordCsatScore(input),
  ]).catch(() => {/* hook failures must never break ingest */});
}

async function maybeSendOutOfHoursReply(input: PostIngestInput): Promise<void> {
  if (!input.isFirstInbound) return;
  const cfg = (input.inboxConfig as { businessHours?: BusinessHoursConfig } | null)
    ?.businessHours;
  if (!cfg?.outOfHoursReply) return;
  if (isWithinBusinessHours(new Date(), cfg)) return;

  const { app, inboxId, conversationId } = input;
  // Insert a system message with the reply.
  const [msg] = await app.db
    .insert(schema.messages)
    .values({
      conversationId,
      inboxId,
      senderType: 'system',
      content: cfg.outOfHoursReply,
      contentType: 'text',
    })
    .returning();
  if (!msg) return;
  eventBus.emitEvent({
    type: 'message.created',
    inboxId,
    conversationId,
    message: {
      id: msg.id,
      conversationId: msg.conversationId,
      inboxId: msg.inboxId,
      senderType: msg.senderType,
      senderId: msg.senderId,
      content: msg.content,
      contentType: msg.contentType,
      mediaUrl: msg.mediaUrl,
      mediaMimeType: msg.mediaMimeType,
      isPrivateNote: msg.isPrivateNote,
      createdAt: msg.createdAt,
    },
  });
  app.log.info({ conversationId, inboxId }, 'post-ingest: out-of-hours auto-reply sent');
}

/** Parse "1"–"5" / "0"–"10" as a CSAT/NPS score if conversation was resolved
 *  recently and no response recorded yet. */
async function maybeRecordCsatScore(input: PostIngestInput): Promise<void> {
  const { app, conversationId, contactId, inboxId, messageContent } = input;
  const trimmed = messageContent.trim();
  const match = /^(?<score>10|[0-9])$/.exec(trimmed);
  if (!match) return;
  const score = Number(match.groups!.score!);

  // The score message itself lands in a FRESH conversation (when the old one
  // was resolved). Attribute the CSAT to the most recently resolved
  // conversation of this contact in this inbox within the last 24h.
  const rows = await app.db
    .select({
      id: schema.conversations.id,
      resolvedAt: schema.conversations.resolvedAt,
    })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.contactId, contactId),
        eq(schema.conversations.inboxId, inboxId),
        gte(
          schema.conversations.resolvedAt,
          new Date(Date.now() - 24 * 3600 * 1000),
        ),
      ),
    )
    .orderBy(schema.conversations.resolvedAt);
  const target = rows[rows.length - 1];
  if (!target?.resolvedAt) return;

  // Skip if already responded.
  const existing = await app.db
    .select({ id: schema.csatResponses.id })
    .from(schema.csatResponses)
    .where(
      and(
        eq(schema.csatResponses.conversationId, target.id),
        gte(schema.csatResponses.respondedAt, target.resolvedAt),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  // 0-10 → NPS; 1-5 → CSAT.
  const kind = score > 5 ? 'nps' : 'csat';
  try {
    await app.db.insert(schema.csatResponses).values({
      conversationId: target.id,
      contactId,
      score,
      kind,
    });
    app.log.info(
      { conversationId: target.id, viaConversationId: conversationId, score, kind },
      'post-ingest: CSAT recorded',
    );
  } catch (err) {
    app.log.warn({ err, conversationId: target.id }, 'post-ingest: CSAT insert failed');
  }
}

/** Trigger called when an agent resolves a conversation. Queues a CSAT prompt
 *  via a scheduled (1min delay) system message so the contact gets asked. */
export async function enqueueCsatPrompt(
  app: FastifyInstance,
  conversationId: string,
): Promise<void> {
  const [conv] = await app.db
    .select({
      inboxId: schema.conversations.inboxId,
      contactId: schema.conversations.contactId,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!conv) return;

  const [inbox] = await app.db
    .select({ config: schema.inboxes.config })
    .from(schema.inboxes)
    .where(eq(schema.inboxes.id, conv.inboxId))
    .limit(1);
  const prompt =
    (inbox?.config as { csat?: { prompt?: string } } | null)?.csat?.prompt ??
    'Como foi seu atendimento? Responda com uma nota de 1 a 5.';

  const scheduledFor = new Date(Date.now() + 60_000);
  const [msg] = await app.db
    .insert(schema.messages)
    .values({
      conversationId,
      inboxId: conv.inboxId,
      senderType: 'system',
      content: prompt,
      contentType: 'text',
      scheduledFor,
      scheduledAt: new Date(),
    })
    .returning();
  if (!msg) return;
  const { QUEUE_NAMES } = await import('../../queue');
  await app.queues
    .getQueue(QUEUE_NAMES.SCHEDULED_MESSAGE)
    .add(
      'publish',
      { messageId: msg.id, conversationId },
      { jobId: `csat-${conversationId}-${Date.now()}`, delay: 60_000 },
    );
}
