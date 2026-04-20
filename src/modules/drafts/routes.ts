import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessConversation } from '../conversations/access';

const idParams = z.object({ id: z.string().uuid() });
const saveBody = z.object({
  content: z.string().max(20_000),
  isPrivateNote: z.boolean().optional(),
});

const TTL_SECONDS = 7 * 24 * 3600;

function draftKey(conversationId: string, userId: string): string {
  return `draft:${conversationId}:${userId}`;
}

/**
 * Per-(conversation, user) composer draft persisted in Redis with 7d TTL.
 * Short-lived UX state, not auditable — Redis is the right home.
 * Empty content deletes the draft entirely (avoids ghost drafts polluting list).
 */
export async function draftRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/conversations/:id/draft',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const raw = await app.redis.get(draftKey(id, req.user.sub));
      if (!raw) return { content: '', isPrivateNote: false };
      try {
        return JSON.parse(raw);
      } catch {
        return { content: '', isPrivateNote: false };
      }
    },
  );

  app.put(
    '/api/v1/conversations/:id/draft',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = saveBody.parse(req.body);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      const key = draftKey(id, req.user.sub);
      if (body.content.length === 0) {
        await app.redis.del(key);
        return reply.code(204).send();
      }
      await app.redis.set(
        key,
        JSON.stringify({
          content: body.content,
          isPrivateNote: body.isPrivateNote ?? false,
        }),
        'EX',
        TTL_SECONDS,
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/conversations/:id/draft',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (!(await canAccessConversation(app, req.user, id))) {
        return reply.forbidden();
      }
      await app.redis.del(draftKey(id, req.user.sub));
      return reply.code(204).send();
    },
  );
}
