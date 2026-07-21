/**
 * Pure delivery function for bot webhooks (no in-memory queueing).
 * Used by the BullMQ worker — retries are managed by the queue itself,
 * so this function should THROW on retryable failures (5xx / network)
 * and return normally on 2xx or non-retryable 4xx.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema, type DB } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { safeFetch } from './safe-fetch';

const TIMEOUT_MS = Number(process.env.BOT_WEBHOOK_TIMEOUT_MS ?? 10_000);
const HISTORY_LIMIT = 20;

export interface DispatchInput {
  conversationId: string;
  inboxId: string;
  contactId: string;
  newMessageId: string;
  botId: string;
  accountId: string;
}

interface Deps {
  db: DB;
  log: FastifyBaseLogger;
}

export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Log a bot event — fire-and-forget, never blocks delivery. */
async function logBotEvent(
  db: DB,
  log: FastifyBaseLogger,
  data: {
    botId: string;
    accountId: string;
    conversationId: string;
    messageId?: string;
    event: string;
    direction: string;
    status: string;
    httpStatus?: number | null;
    latencyMs?: number | null;
    attempt?: number;
    payload?: unknown;
    error?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(schema.botEvents).values({
      botId: data.botId,
      accountId: data.accountId,
      conversationId: data.conversationId,
      messageId: data.messageId ?? undefined,
      event: data.event,
      direction: data.direction,
      status: data.status,
      httpStatus: data.httpStatus ?? undefined,
      latencyMs: data.latencyMs ?? undefined,
      attempt: data.attempt ?? 1,
      payload: data.payload ?? undefined,
      error: data.error ?? undefined,
    });
  } catch (err) {
    log.warn({ err, botId: data.botId }, 'bot_events insert failed (non-critical)');
  }
}

export async function deliverBotWebhook(
  input: DispatchInput,
  { db, log }: Deps,
): Promise<void> {
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, input.conversationId))
    .limit(1);
  if (!conv || !conv.assignedBotId) return; // not assigned anymore — silent skip

  const [bot] = await db
    .select()
    .from(schema.bots)
    .where(eq(schema.bots.id, conv.assignedBotId))
    .limit(1);
  if (!bot || !bot.enabled) return;

  // Built-in bots use the internal LLM processor instead of webhook delivery.
  if (bot.botType === 'builtin') {
    const { processBuiltinBot } = await import('./builtin-processor');
    await processBuiltinBot(input, { db, log });
    return;
  }

  if (!bot.webhookUrl) {
    log.warn({ botId: bot.id }, 'bot: external bot has no webhookUrl');
    return;
  }

  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, input.contactId))
    .limit(1);
  if (!contact) return;

  const historyRows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, input.conversationId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(HISTORY_LIMIT * 2);
  type MsgRow = (typeof historyRows)[number];
  const history: MsgRow[] = historyRows
    .filter((m) => !m.isPrivateNote)
    .slice(0, HISTORY_LIMIT)
    .reverse();

  const newMessage = history.find((m) => m.id === input.newMessageId);
  if (!newMessage) return;

  const payload = {
    eventId: randomUUID(),
    event: 'message.created',
    timestamp: new Date().toISOString(),
    conversation: {
      id: conv.id,
      inboxId: conv.inboxId,
      status: conv.status,
      priority: conv.priority,
    },
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      customFields: contact.customFields,
    },
    message: {
      id: newMessage.id,
      content: newMessage.content,
      contentType: newMessage.contentType,
      mediaUrl: newMessage.mediaUrl,
      senderType: newMessage.senderType,
      isPrivateNote: newMessage.isPrivateNote,
      createdAt: newMessage.createdAt,
    },
    history: history.map((m) => ({
      id: m.id,
      content: m.content,
      contentType: m.contentType,
      senderType: m.senderType,
      isPrivateNote: m.isPrivateNote,
      createdAt: m.createdAt,
    })),
  };

  const body = JSON.stringify(payload);
  let secret: string;
  try {
    secret = decryptJSON<string>(bot.secret);
  } catch (err) {
    log.error({ err, botId: bot.id }, 'bot: failed to decrypt secret');
    return;
  }
  const signature = signPayload(body, secret);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await safeFetch(bot.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Blossom-Signature': signature,
        'X-Blossom-Event': 'message.created',
        'X-Blossom-Event-Id': payload.eventId,
        'User-Agent': 'BlossomInbox/0.1 bot-dispatcher',
      },
      body,
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      log.debug({ botId: bot.id, latencyMs }, 'bot webhook delivered');
      void logBotEvent(db, log, {
        botId: bot.id,
        accountId: bot.accountId,
        conversationId: input.conversationId,
        messageId: input.newMessageId,
        event: 'dispatch',
        direction: 'outbound',
        status: 'success',
        httpStatus: res.status,
        latencyMs,
        payload: { eventId: payload.eventId },
      });
      return;
    }

    if (res.status >= 400 && res.status < 500) {
      const text = await res.text().catch(() => '');
      log.warn(
        { botId: bot.id, status: res.status, body: text.slice(0, 200) },
        'bot webhook 4xx — giving up (no retry)',
      );
      void logBotEvent(db, log, {
        botId: bot.id,
        accountId: bot.accountId,
        conversationId: input.conversationId,
        messageId: input.newMessageId,
        event: 'dispatch',
        direction: 'outbound',
        status: 'failed',
        httpStatus: res.status,
        latencyMs,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      });
      return; // do not throw — 4xx is non-retryable
    }

    // 5xx → log and throw to let BullMQ retry
    void logBotEvent(db, log, {
      botId: bot.id,
      accountId: bot.accountId,
      conversationId: input.conversationId,
      messageId: input.newMessageId,
      event: 'dispatch',
      direction: 'outbound',
      status: 'failed',
      httpStatus: res.status,
      latencyMs,
      error: `HTTP ${res.status}`,
    });
    throw new Error(`bot webhook 5xx: ${res.status}`);
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAbort = err instanceof Error && err.name === 'AbortError';

    if (isAbort) {
      void logBotEvent(db, log, {
        botId: bot.id,
        accountId: bot.accountId,
        conversationId: input.conversationId,
        messageId: input.newMessageId,
        event: 'dispatch',
        direction: 'outbound',
        status: 'timeout',
        latencyMs,
        error: `Timeout after ${TIMEOUT_MS}ms`,
      });
    }

    throw err; // re-throw for BullMQ retry
  } finally {
    clearTimeout(timer);
  }
}
