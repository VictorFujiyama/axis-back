import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { schema, type DB } from '@blossom/db';
import type { ChannelType } from '@blossom/shared-types';
import { dispatchBot } from '../bots/dispatcher';
import { eventBus } from '../../realtime/event-bus';

export interface IncomingMessage {
  inboxId: string;
  channel: ChannelType;
  from: {
    /** Unique per-channel identifier (phone, email, visitor id) */
    identifier: string;
    name?: string;
    email?: string;
    phone?: string;
    metadata?: Record<string, unknown>;
  };
  content: string;
  contentType?: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location';
  mediaUrl?: string;
  mediaMimeType?: string;
  /** Required for idempotency. Must be unique per (inboxId, channel). */
  channelMsgId: string;
  /** Optional hints that help threading (e.g. email In-Reply-To list, WhatsApp context id). */
  threadHints?: string[];
  /** Arbitrary metadata stored on the message (headers, raw provider ids, etc.) */
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  contactId: string;
  conversationId: string | null;
  messageId: string | null;
  deduped: boolean;
  blocked: boolean;
  message?: typeof schema.messages.$inferSelect;
}

export interface IngestDeps {
  db: DB;
  log: FastifyBaseLogger;
  /** Optional JSONB shape of inbox.config (legacy — prefer defaultBotId). */
  inboxConfig?: unknown;
  /** Default bot ID for this inbox (formal column). Takes priority over inboxConfig. */
  defaultBotId?: string | null;
  /** Optional BullMQ queue for bot dispatch (recommended). When absent,
   * falls back to in-process best-effort delivery (tests). */
  botQueue?: import('bullmq').Queue<import('../../queue').BotDispatchJob>;
  /** Optional Redis handle for rate-limit enforcement. */
  redis?: import('ioredis').Redis;
}

/**
 * Persists an incoming message from any channel: find-or-create contact,
 * dedup by channelMsgId, reuse active conversation or create new (with default bot),
 * emit realtime event, fire bot dispatch.
 *
 * Idempotent: re-sending the same channelMsgId returns the same message.
 */
export async function ingestIncomingMessage(
  input: IncomingMessage,
  deps: IngestDeps,
): Promise<IngestResult> {
  const { db, log, inboxConfig } = deps;
  const now = new Date();

  // Rate limit per contact — best effort via redis if provided.
  // Check AFTER dedup inside the tx would require nested tx; we compute a
  // dedup pre-check here so provider retries (same channelMsgId) don't consume
  // rate budget.
  if (deps.redis) {
    const dedupKey = `ingest-dedup:${input.inboxId}:${input.channelMsgId}`;
    const seen = await deps.redis.get(dedupKey).catch(() => null);
    if (!seen) {
      const bucket = Math.floor(Date.now() / 1000 / 60);
      const key = `contact-rate:${input.channel}:${input.from.identifier}:${bucket}`;
      const n = await deps.redis.incr(key).catch(() => 0);
      if (n === 1) await deps.redis.expire(key, 60).catch(() => {/* ignore */});
      if (n > 30) {
        log.warn(
          {
            channel: input.channel,
            from: input.from.identifier,
            channelMsgId: input.channelMsgId,
            attempts: n,
          },
          'channels: rate limit — dropping inbound',
        );
        return {
          contactId: '',
          conversationId: null,
          messageId: null,
          deduped: false,
          blocked: true,
        };
      }
      // Remember the channelMsgId briefly so provider retries don't consume
      // rate budget again during the same minute window.
      await deps.redis.set(dedupKey, '1', 'EX', 120).catch(() => {/* ignore */});
    }
  }

  const result = await db.transaction(async (tx) => {
    // 1. Find or create contact identity
    const [identity] = await tx
      .select()
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.channel, input.channel),
          eq(schema.contactIdentities.identifier, input.from.identifier),
        ),
      )
      .limit(1);

    let contactId: string;
    if (identity) {
      contactId = identity.contactId;
      const [c] = await tx
        .select({ blocked: schema.contacts.blocked })
        .from(schema.contacts)
        .where(eq(schema.contacts.id, contactId))
        .limit(1);
      if (c?.blocked) {
        return { contactId, conversationId: null, messageId: null, deduped: false, blocked: true };
      }
    } else {
      const [contact] = await tx
        .insert(schema.contacts)
        .values({
          name: input.from.name,
          email: input.from.email,
          phone: input.from.phone,
        })
        .returning({ id: schema.contacts.id });
      if (!contact) throw new Error('contact insert failed');
      contactId = contact.id;
      await tx.insert(schema.contactIdentities).values({
        contactId,
        channel: input.channel,
        identifier: input.from.identifier,
        metadata: input.from.metadata ?? {},
      });
    }

    // 2. Idempotency — dedup by (inboxId, channelMsgId)
    const [existing] = await tx
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.inboxId, input.inboxId),
          eq(schema.messages.channelMsgId, input.channelMsgId),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        contactId,
        conversationId: existing.conversationId,
        messageId: existing.id,
        deduped: true,
        blocked: false,
      };
    }

    // 3. Threading — try hints first, otherwise find active conversation.
    let conversationId: string | undefined;
    if (input.threadHints && input.threadHints.length) {
      const [hintedMsg] = await tx
        .select({ conversationId: schema.messages.conversationId })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.inboxId, input.inboxId),
            inArray(schema.messages.channelMsgId, input.threadHints),
          ),
        )
        .limit(1);
      if (hintedMsg) {
        const [hintedConv] = await tx
          .select()
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.id, hintedMsg.conversationId),
              isNull(schema.conversations.deletedAt),
            ),
          )
          .limit(1);
        if (hintedConv) {
          if (hintedConv.contactId !== contactId) {
            // Thread hijack attempt: forged In-Reply-To pointing to another contact's
            // conversation. Refuse to thread, log, and fall through to creating a new conv.
            log.warn(
              {
                inboxId: input.inboxId,
                attemptedConvId: hintedConv.id,
                attemptedContactId: hintedConv.contactId,
                actualContactId: contactId,
                channel: input.channel,
                from: input.from.identifier,
              },
              'channels: thread-hijack attempt — In-Reply-To references another contact',
            );
          } else if (hintedConv.status !== 'resolved') {
            conversationId = hintedConv.id;
          }
        }
      }
    }

    let reopened = false;
    let activeConv: typeof schema.conversations.$inferSelect | undefined;
    if (!conversationId) {
      // Latest active (non-resolved) conversation for this contact in this inbox
      const rows = await tx
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.contactId, contactId),
            eq(schema.conversations.inboxId, input.inboxId),
            isNull(schema.conversations.deletedAt),
            inArray(schema.conversations.status, ['open', 'pending', 'snoozed']),
          ),
        )
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(1);
      activeConv = rows[0];
      if (activeConv) {
        conversationId = activeConv.id;
        reopened = activeConv.status !== 'open';
      }
    }

    if (!conversationId) {
      // Create new — auto-assign default bot from inbox.defaultBotId column
      // (falls back to legacy inboxConfig.defaultBotId for backwards compat).
      const resolvedBotId =
        deps.defaultBotId ??
        (typeof inboxConfig === 'object' &&
        inboxConfig !== null &&
        'defaultBotId' in inboxConfig &&
        typeof (inboxConfig as { defaultBotId?: unknown }).defaultBotId === 'string'
          ? ((inboxConfig as { defaultBotId: string }).defaultBotId)
          : null);
      const [newConv] = await tx
        .insert(schema.conversations)
        .values({
          contactId,
          inboxId: input.inboxId,
          // Bot-managed conversations start as 'pending' — invisible to human agents
          // until the bot hands off or fails.
          status: resolvedBotId ? 'pending' : 'open',
          assignedBotId: resolvedBotId,
          waitingForAgentSince: resolvedBotId ? null : now,
          lastMessageAt: now,
        })
        .returning({ id: schema.conversations.id });
      if (!newConv) throw new Error('conversation insert failed');
      conversationId = newConv.id;
    }

    // 4. Insert message
    const [message] = await tx
      .insert(schema.messages)
      .values({
        conversationId,
        inboxId: input.inboxId,
        senderType: 'contact',
        senderId: contactId,
        content: input.content,
        contentType: input.contentType ?? 'text',
        mediaUrl: input.mediaUrl,
        mediaMimeType: input.mediaMimeType,
        channelMsgId: input.channelMsgId,
        metadata: input.metadata ?? {},
        deliveredAt: now,
      })
      .returning();

    // 5. Update timestamps on existing conv (new-conv path already has them set)
    if (activeConv) {
      await tx
        .update(schema.conversations)
        .set({
          lastMessageAt: now,
          updatedAt: now,
          ...(reopened
            ? { status: 'open', waitingForAgentSince: now }
            : { waitingForAgentSince: activeConv.waitingForAgentSince ?? now }),
        })
        .where(eq(schema.conversations.id, conversationId));
    }

    return {
      contactId,
      conversationId,
      messageId: message!.id,
      deduped: false,
      blocked: false,
      message: message!,
    };
  });

  if (result.blocked) {
    log.info({ inboxId: input.inboxId, contactId: result.contactId }, 'channel: blocked contact');
    return result;
  }

  // 6. Side effects (outside tx). Emit BEFORE dispatching the bot so the
  // contact's message is observed by clients before the bot's reply arrives.
  if (!result.deduped && result.message && result.conversationId) {
    const m = result.message;
    eventBus.emitEvent({
      type: 'message.created',
      inboxId: input.inboxId,
      conversationId: result.conversationId,
      message: {
        id: m.id,
        conversationId: m.conversationId,
        inboxId: m.inboxId,
        senderType: m.senderType,
        senderId: m.senderId,
        content: m.content,
        contentType: m.contentType,
        isPrivateNote: m.isPrivateNote,
        createdAt: m.createdAt,
      },
    });

    // Resolve the bot assigned to this conversation to include in the job.
    const [convForBot] = await db
      .select({
        assignedBotId: schema.conversations.assignedBotId,
        accountId: schema.conversations.accountId,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, result.conversationId))
      .limit(1);
    if (convForBot?.assignedBotId && convForBot.accountId) {
      dispatchBot(
        {
          conversationId: result.conversationId,
          inboxId: input.inboxId,
          contactId: result.contactId,
          newMessageId: m.id,
          botId: convForBot.assignedBotId,
          accountId: convForBot.accountId,
        },
        { db, log, queue: deps.botQueue },
      );
    }
  }

  return result;
}
