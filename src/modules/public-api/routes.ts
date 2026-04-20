import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { requireApiKey } from '../api-keys/routes';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['open', 'pending', 'resolved', 'snoozed']).optional(),
});

const sendBody = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1).max(20_000),
  isPrivateNote: z.boolean().default(false),
});

/**
 * Public API v1 — authenticated via `Authorization: Bearer <apikey>` rather
 * than session JWT. Scope check: keys with scope '*' or 'conversations:read/write'
 * grant access. (Finer scope enforcement is a follow-up.)
 */
export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  const authGuard = requireApiKey(app);

  app.get(
    '/api/public/v1/conversations',
    { preHandler: authGuard },
    async (req) => {
      const q = listQuery.parse(req.query);
      const conds = [isNull(schema.conversations.deletedAt)];
      if (q.status) conds.push(eq(schema.conversations.status, q.status));
      const rows = await app.db
        .select({
          id: schema.conversations.id,
          contactId: schema.conversations.contactId,
          inboxId: schema.conversations.inboxId,
          status: schema.conversations.status,
          priority: schema.conversations.priority,
          createdAt: schema.conversations.createdAt,
          updatedAt: schema.conversations.updatedAt,
        })
        .from(schema.conversations)
        .where(and(...conds))
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(q.limit);
      return { items: rows };
    },
  );

  app.post(
    '/api/public/v1/messages',
    { preHandler: authGuard },
    async (req, reply) => {
      const body = sendBody.parse(req.body);
      const [conv] = await app.db
        .select({ inboxId: schema.conversations.inboxId, status: schema.conversations.status })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, body.conversationId))
        .limit(1);
      if (!conv) return reply.notFound();
      if (conv.status === 'resolved') {
        return reply.badRequest('Conversa resolvida; reabra antes de enviar.');
      }
      const [msg] = await app.db
        .insert(schema.messages)
        .values({
          conversationId: body.conversationId,
          inboxId: conv.inboxId,
          senderType: 'system',
          content: body.content,
          contentType: 'text',
          isPrivateNote: body.isPrivateNote,
        })
        .returning();
      return reply.code(201).send({
        id: msg!.id,
        conversationId: msg!.conversationId,
        content: msg!.content,
        isPrivateNote: msg!.isPrivateNote,
        createdAt: msg!.createdAt,
      });
    },
  );
}
