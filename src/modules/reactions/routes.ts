import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { canAccessConversation } from '../conversations/access';

const idParams = z.object({ id: z.string().uuid() });
const reactBody = z.object({ emoji: z.string().min(1).max(16) });

export async function reactionRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/messages/:id/reactions',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [msg] = await app.db
        .select({ conversationId: schema.messages.conversationId })
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!msg) return reply.notFound();
      if (!(await canAccessConversation(app, req.user, msg.conversationId))) {
        return reply.forbidden();
      }
      const rows = await app.db
        .select()
        .from(schema.messageReactions)
        .where(eq(schema.messageReactions.messageId, id));
      return { items: rows };
    },
  );

  app.post(
    '/api/v1/messages/:id/reactions',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = reactBody.parse(req.body);
      const [msg] = await app.db
        .select({ conversationId: schema.messages.conversationId })
        .from(schema.messages)
        .where(eq(schema.messages.id, id))
        .limit(1);
      if (!msg) return reply.notFound();
      if (!(await canAccessConversation(app, req.user, msg.conversationId))) {
        return reply.forbidden();
      }
      try {
        await app.db.insert(schema.messageReactions).values({
          messageId: id,
          userId: req.user.sub,
          emoji: body.emoji,
        });
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/messages/:id/reactions',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = reactBody.parse(req.body);
      await app.db
        .delete(schema.messageReactions)
        .where(
          and(
            eq(schema.messageReactions.messageId, id),
            eq(schema.messageReactions.userId, req.user.sub),
            eq(schema.messageReactions.emoji, body.emoji),
          ),
        );
      return reply.code(204).send();
    },
  );
}
