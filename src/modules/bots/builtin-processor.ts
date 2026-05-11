/**
 * Processes messages for built-in AI bots.
 * Called by the dispatcher when bot.botType === 'builtin'.
 *
 * Flow:
 * 1. Load conversation, bot, contact, history
 * 2. Check if greeting is needed (first interaction)
 * 3. Map history to LLM message format
 * 4. Detect handoff triggers in contact's message
 * 5. Call LLM
 * 6. Insert bot response + emit WebSocket
 * 7. Check max turns safety net
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import { schema, type DB } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { eventBus } from '../../realtime/event-bus';
import { parseBuiltinConfig, type BuiltinBotConfig } from './builtin-config';
import { callLLM, resolveApiKey, type LLMMessage } from './llm-client';
import { fetchPlaybook, type PlaybookSource } from './playbook-fetcher';

const HISTORY_LIMIT = 20;

export interface ProcessInput {
  conversationId: string;
  inboxId: string;
  contactId: string;
  newMessageId: string;
  botId: string;
  accountId: string;
}

export async function processBuiltinBot(
  input: ProcessInput,
  {
    db,
    log,
    redis,
    fetchImpl,
  }: {
    db: DB;
    log: FastifyBaseLogger;
    redis: Redis;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  // ── 1. Load entities ──────────────────────────────────────────────
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, input.conversationId))
    .limit(1);
  if (!conv || conv.assignedBotId !== input.botId) return;

  const [bot] = await db
    .select()
    .from(schema.bots)
    .where(eq(schema.bots.id, input.botId))
    .limit(1);
  if (!bot || !bot.enabled || bot.botType !== 'builtin') return;

  let cfg: BuiltinBotConfig;
  try {
    cfg = parseBuiltinConfig(bot.config);
  } catch (err) {
    log.error({ err, botId: bot.id }, 'builtin-bot: invalid config');
    return;
  }

  // ── 2. Resolve API key ────────────────────────────────────────────
  let botApiKey: string | null = null;
  try {
    botApiKey = decryptJSON<string>(bot.secret);
    // If it starts with 'blsk_' it's a webhook secret, not an API key
    if (botApiKey.startsWith('blsk_')) botApiKey = null;
  } catch {
    // Secret might not contain a valid API key
  }
  const apiKey = resolveApiKey(cfg.provider, botApiKey);
  if (!apiKey) {
    log.error({ botId: bot.id, provider: cfg.provider }, 'builtin-bot: no API key available');
    return;
  }

  // ── 2.5. Resolve effective system prompt (Atlas playbook or inline) ──
  const playbookStart = Date.now();
  let effectiveSystemPrompt = cfg.systemPrompt;
  let playbookFetchResult: { source: PlaybookSource; etag: string } | null = null;
  let playbookFetchError: string | undefined;
  if (cfg.playbookSource === 'atlas') {
    try {
      const playbook = await fetchPlaybook(
        input.inboxId,
        { redis, log },
        { fetchImpl },
      );
      if (playbook) {
        effectiveSystemPrompt = playbook.markdown;
        playbookFetchResult = { source: playbook.source, etag: playbook.etag };
      } else {
        log.warn(
          { botId: bot.id, inboxId: input.inboxId },
          'builtin-bot: playbook fetch returned null; falling back to inline systemPrompt',
        );
      }
    } catch (err) {
      playbookFetchError = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
      log.warn(
        { err, botId: bot.id, inboxId: input.inboxId },
        'builtin-bot: playbook fetch threw',
      );
    }
    // T-016b will insert the bot_events row here; pin the bookkeeping vars
    // so the compiler doesn't flag them as unused in the meantime.
    void playbookFetchResult;
    void playbookFetchError;
    void playbookStart;
  }

  // ── 3. Load message history ───────────────────────────────────────
  const historyRows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, input.conversationId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(HISTORY_LIMIT * 2);
  const history = historyRows
    .filter((m) => !m.isPrivateNote)
    .slice(0, HISTORY_LIMIT)
    .reverse();

  const newMessage = history.find((m) => m.id === input.newMessageId);
  if (!newMessage || !newMessage.content) return;

  // ── 4. Greeting message (first bot interaction) ───────────────────
  const botMessages = history.filter((m) => m.senderType === 'bot');
  if (botMessages.length === 0 && cfg.greetingMessage) {
    await insertBotMessage(db, {
      conversationId: input.conversationId,
      inboxId: input.inboxId,
      botId: bot.id,
      content: cfg.greetingMessage,
    });
    log.info({ botId: bot.id, conversationId: input.conversationId }, 'builtin-bot: greeting sent');
  }

  // ── 5. Check handoff keywords in contact's message ────────────────
  if (cfg.handoffKeywords.length > 0) {
    const lowerContent = newMessage.content.toLowerCase();
    const triggered = cfg.handoffKeywords.some((kw) =>
      lowerContent.includes(kw.toLowerCase()),
    );
    if (triggered) {
      await doHandoff(db, log, input, bot.id);
      return;
    }
  }

  // ── 6. Check max turns safety net ─────────────────────────────────
  if (cfg.maxTurnsBeforeHandoff !== null && botMessages.length >= cfg.maxTurnsBeforeHandoff) {
    log.info({ botId: bot.id, turns: botMessages.length }, 'builtin-bot: max turns reached — handoff');
    await doHandoff(db, log, input, bot.id);
    return;
  }

  // ── 7. Map history to LLM messages ────────────────────────────────
  const llmMessages: LLMMessage[] = [];
  for (const m of history) {
    if (!m.content) continue;
    if (m.senderType === 'contact') {
      llmMessages.push({ role: 'user', content: m.content });
    } else if (m.senderType === 'bot') {
      llmMessages.push({ role: 'assistant', content: m.content });
    }
    // system/user (human agent) messages are skipped for the LLM
  }

  // ── 8. Call LLM ───────────────────────────────────────────────────
  const start = Date.now();
  let response: Awaited<ReturnType<typeof callLLM>>;
  try {
    response = await callLLM({
      provider: cfg.provider,
      model: cfg.model,
      apiKey,
      systemPrompt: effectiveSystemPrompt,
      messages: llmMessages,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    log.error({ err, botId: bot.id, latencyMs }, 'builtin-bot: LLM call failed');
    // Log in bot_events
    await db.insert(schema.botEvents).values({
      botId: bot.id,
      accountId: input.accountId,
      conversationId: input.conversationId,
      messageId: input.newMessageId,
      event: 'llm_call',
      direction: 'outbound',
      status: 'failed',
      latencyMs,
      error: err instanceof Error ? err.message.slice(0, 500) : 'LLM error',
    }).catch(() => {});
    throw err; // re-throw for BullMQ retry
  }
  const latencyMs = Date.now() - start;

  if (!response.content || response.content.trim().length === 0) {
    log.warn({ botId: bot.id }, 'builtin-bot: empty LLM response');
    return;
  }

  // ── 9. Log success in bot_events ──────────────────────────────────
  await db.insert(schema.botEvents).values({
    botId: bot.id,
    accountId: input.accountId,
    conversationId: input.conversationId,
    messageId: input.newMessageId,
    event: 'llm_call',
    direction: 'outbound',
    status: 'success',
    latencyMs,
    payload: {
      provider: cfg.provider,
      model: cfg.model,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    },
  }).catch((err) => log.warn({ err }, 'bot_events insert failed'));

  // ── 10. Insert bot response ───────────────────────────────────────
  await insertBotMessage(db, {
    conversationId: input.conversationId,
    inboxId: input.inboxId,
    botId: bot.id,
    content: response.content,
  });

  log.info(
    { botId: bot.id, conversationId: input.conversationId, latencyMs, tokens: response.usage },
    'builtin-bot: response sent',
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

async function insertBotMessage(
  db: DB,
  data: { conversationId: string; inboxId: string; botId: string; content: string },
): Promise<void> {
  const now = new Date();

  // Optimistic concurrency: only insert if bot is still the owner
  const [updated] = await db
    .update(schema.conversations)
    .set({
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.conversations.id, data.conversationId),
        eq(schema.conversations.assignedBotId, data.botId),
      ),
    )
    .returning({ id: schema.conversations.id });
  if (!updated) return; // bot was unassigned during LLM call

  const [msg] = await db
    .insert(schema.messages)
    .values({
      conversationId: data.conversationId,
      inboxId: data.inboxId,
      senderType: 'bot',
      senderId: data.botId,
      content: data.content,
      contentType: 'text',
    })
    .returning();

  if (msg) {
    eventBus.emitEvent({
      type: 'message.created',
      inboxId: data.inboxId,
      conversationId: data.conversationId,
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
  }
}

async function doHandoff(
  db: DB,
  log: FastifyBaseLogger,
  input: ProcessInput,
  botId: string,
): Promise<void> {
  const now = new Date();

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
        eq(schema.conversations.assignedBotId, botId),
      ),
    )
    .returning({ id: schema.conversations.id, inboxId: schema.conversations.inboxId });

  if (!conv) return;

  await db.insert(schema.messages).values({
    conversationId: input.conversationId,
    inboxId: conv.inboxId,
    senderType: 'system',
    content: 'Bot transferiu a conversa para um atendente humano.',
    isPrivateNote: true,
  });

  eventBus.emitEvent({
    type: 'conversation.assigned',
    inboxId: conv.inboxId,
    conversationId: input.conversationId,
    assignedUserId: null,
    assignedTeamId: null,
    assignedBotId: null,
  });

  log.info({ botId, conversationId: input.conversationId }, 'builtin-bot: handoff to human');
}
