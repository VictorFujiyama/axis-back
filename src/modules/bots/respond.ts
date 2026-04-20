import { timingSafeEqual, createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON } from '../../crypto';
import { eventBus } from '../../realtime/event-bus';

const idParams = z.object({ id: z.string().uuid() });

const messageSchema = z.object({
  type: z.literal('message').optional().default('message'),
  conversationId: z.string().uuid(),
  content: z.string().min(1).max(20_000),
  contentType: z.enum(['text', 'image', 'audio', 'video', 'document']).default('text'),
  mediaUrl: z.string().url().optional(),
  isPrivateNote: z.boolean().default(false),
});

const handoffAction = z.object({
  type: z.literal('handoff'),
  conversationId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  note: z.string().max(500).optional(),
});

const resolveAction = z.object({
  type: z.literal('resolve'),
  conversationId: z.string().uuid(),
});

const tagAction = z.object({
  type: z.literal('tag'),
  conversationId: z.string().uuid(),
  add: z.array(z.string().uuid()).optional(),
  remove: z.array(z.string().uuid()).optional(),
});

const updateContactAction = z.object({
  type: z.literal('update_contact'),
  contactId: z.string().uuid(),
  customFields: z.record(z.unknown()).optional(),
});

const respondBody = z.discriminatedUnion('type', [
  messageSchema.extend({ type: z.literal('message') }),
  handoffAction,
  resolveAction,
  tagAction,
  updateContactAction,
]);

function constantTimeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function botRespondRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/bots/:id/respond',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);

      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.unauthorized('Missing bearer token');
      }
      const token = auth.slice('Bearer '.length).trim();

      const [bot] = await app.db
        .select()
        .from(schema.bots)
        .where(eq(schema.bots.id, id))
        .limit(1);
      if (!bot || !bot.enabled) return reply.unauthorized('Bot not found or disabled');

      let plainSecret: string;
      try {
        plainSecret = decryptJSON<string>(bot.secret);
      } catch {
        return reply.internalServerError('Bot misconfigured');
      }
      if (!constantTimeEqualStr(token, plainSecret)) {
        app.log.warn({ botId: id, ip: req.ip }, 'bot.respond: invalid bearer token');
        return reply.unauthorized('Invalid token');
      }

      // Idempotency: check if same key was processed; only mark as done after success.
      const idemKey = req.headers['x-idempotency-key'];
      const validIdemKey =
        typeof idemKey === 'string' && idemKey.length > 0 && idemKey.length <= 128
          ? idemKey
          : null;
      const idemRedisKey = validIdemKey ? `bot:respond:idem:${id}:${validIdemKey}` : null;
      if (idemRedisKey) {
        const cached = await app.redis.get(idemRedisKey);
        if (cached) return reply.code(200).send({ deduped: true });
      }

      const body = respondBody.parse(req.body);
      const now = new Date();

      // Validate target conversation belongs to bot's inbox
      let convInboxId: string | null = null;
      if ('conversationId' in body && body.conversationId) {
        const [conv] = await app.db
          .select({
            id: schema.conversations.id,
            inboxId: schema.conversations.inboxId,
            status: schema.conversations.status,
          })
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.id, body.conversationId),
              isNull(schema.conversations.deletedAt),
            ),
          )
          .limit(1);
        if (!conv) return reply.notFound('conversation not found');
        if (conv.inboxId !== bot.inboxId) {
          return reply.forbidden('conversation belongs to another inbox');
        }
        if (conv.status === 'resolved' && body.type !== 'tag') {
          return reply.badRequest('conversation is resolved');
        }
        convInboxId = conv.inboxId;
      }

      switch (body.type) {
        case 'message': {
          // Optimistic concurrency: only let the bot send if it's still the
          // assigned owner. Prevents stale bot replies after a handoff.
          const stillOwner = await app.db
            .update(schema.conversations)
            .set({
              lastMessageAt: body.isPrivateNote ? sql`last_message_at` : now,
              updatedAt: now,
              ...(body.isPrivateNote
                ? {}
                : {
                    waitingForAgentSince: null,
                    ...(await firstResponsePatch(app, body.conversationId)),
                  }),
            })
            .where(
              and(
                eq(schema.conversations.id, body.conversationId),
                eq(schema.conversations.assignedBotId, bot.id),
              ),
            )
            .returning({ id: schema.conversations.id });
          if (stillOwner.length === 0) {
            return reply.conflict('Bot no longer owns this conversation');
          }
          const [msg] = await app.db
            .insert(schema.messages)
            .values({
              conversationId: body.conversationId,
              inboxId: convInboxId!,
              senderType: 'bot',
              senderId: bot.id,
              content: body.content,
              contentType: body.contentType,
              mediaUrl: body.mediaUrl,
              isPrivateNote: body.isPrivateNote,
            })
            .returning();
          eventBus.emitEvent({
            type: 'message.created',
            inboxId: convInboxId!,
            conversationId: body.conversationId,
            message: {
              id: msg!.id,
              conversationId: msg!.conversationId,
              inboxId: msg!.inboxId,
              senderType: msg!.senderType,
              senderId: msg!.senderId,
              content: msg!.content,
              contentType: msg!.contentType,
              isPrivateNote: msg!.isPrivateNote,
              createdAt: msg!.createdAt,
            },
          });
          if (idemRedisKey) await app.redis.set(idemRedisKey, '1', 'EX', 3600);
          return reply.code(201).send({ messageId: msg!.id });
        }

        case 'handoff': {
          // Validate userId/teamId membership in inbox
          if (body.userId) {
            const [m] = await app.db
              .select({ userId: schema.inboxMembers.userId })
              .from(schema.inboxMembers)
              .where(
                and(
                  eq(schema.inboxMembers.inboxId, bot.inboxId),
                  eq(schema.inboxMembers.userId, body.userId),
                ),
              )
              .limit(1);
            if (!m) return reply.badRequest('user is not member of this inbox');
          }

          // Only allow handoff if bot is still the owner.
          const handed = await app.db
            .update(schema.conversations)
            .set({
              assignedBotId: null,
              assignedUserId: body.userId ?? null,
              assignedTeamId: body.teamId ?? null,
              status: 'pending',
              waitingForAgentSince: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.conversations.id, body.conversationId),
                eq(schema.conversations.assignedBotId, bot.id),
              ),
            )
            .returning({ id: schema.conversations.id });
          if (handed.length === 0) {
            return reply.conflict('Bot no longer owns this conversation');
          }

          if (body.note) {
            await app.db.insert(schema.messages).values({
              conversationId: body.conversationId,
              inboxId: convInboxId!,
              senderType: 'system',
              content: `🤖→👤 Handoff do bot: ${body.note}`,
              isPrivateNote: true,
            });
          }
          eventBus.emitEvent({
            type: 'conversation.assigned',
            inboxId: convInboxId!,
            conversationId: body.conversationId,
            assignedUserId: body.userId ?? null,
            assignedTeamId: body.teamId ?? null,
            assignedBotId: null,
          });
          if (idemRedisKey) await app.redis.set(idemRedisKey, '1', 'EX', 3600);
          return reply.code(204).send();
        }

        case 'resolve': {
          const resolved = await app.db
            .update(schema.conversations)
            .set({
              status: 'resolved',
              resolvedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.conversations.id, body.conversationId),
                eq(schema.conversations.assignedBotId, bot.id),
              ),
            )
            .returning({ id: schema.conversations.id });
          if (resolved.length === 0) {
            return reply.conflict('Bot no longer owns this conversation');
          }
          if (idemRedisKey) await app.redis.set(idemRedisKey, '1', 'EX', 3600);
          return reply.code(204).send();
        }

        case 'tag': {
          if (body.add?.length) {
            await app.db
              .insert(schema.conversationTags)
              .values(
                body.add.map((tagId) => ({
                  conversationId: body.conversationId,
                  tagId,
                })),
              )
              .onConflictDoNothing();
          }
          if (body.remove?.length) {
            await app.db
              .delete(schema.conversationTags)
              .where(
                and(
                  eq(schema.conversationTags.conversationId, body.conversationId),
                  inArray(schema.conversationTags.tagId, body.remove),
                ),
              );
          }
          if (idemRedisKey) await app.redis.set(idemRedisKey, '1', 'EX', 3600);
          return reply.code(204).send();
        }

        case 'update_contact': {
          // Validate that this contact has had a conversation in the bot's inbox —
          // prevents cross-inbox PII writes.
          const [allowed] = await app.db
            .select({ id: schema.conversations.id })
            .from(schema.conversations)
            .where(
              and(
                eq(schema.conversations.contactId, body.contactId),
                eq(schema.conversations.inboxId, bot.inboxId),
              ),
            )
            .limit(1);
          if (!allowed) {
            return reply.forbidden('contact not in this bot inbox scope');
          }
          if (body.customFields !== undefined) {
            await app.db
              .update(schema.contacts)
              .set({ customFields: body.customFields, updatedAt: now })
              .where(eq(schema.contacts.id, body.contactId));
          }
          if (idemRedisKey) await app.redis.set(idemRedisKey, '1', 'EX', 3600);
          return reply.code(204).send();
        }
      }
    },
  );
}

async function firstResponsePatch(
  app: FastifyInstance,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const [conv] = await app.db
    .select({ firstResponseAt: schema.conversations.firstResponseAt })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  return conv?.firstResponseAt ? {} : { firstResponseAt: new Date() };
}
