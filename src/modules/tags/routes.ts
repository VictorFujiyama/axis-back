import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const createBody = z.object({
  name: z.string().min(1).max(60).transform((v) => v.trim().toLowerCase()),
  color: z.string().regex(HEX_COLOR).default('#7b3fa9'),
  showOnSidebar: z.boolean().default(false),
});

const updateBody = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.string().regex(HEX_COLOR).optional(),
  showOnSidebar: z.boolean().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/tags', { preHandler: app.requireAuth }, async (req) => {
    const rows = await app.db.select().from(schema.tags)
      .where(eq(schema.tags.accountId, req.user.accountId));
    return { items: rows };
  });

  app.post(
    '/api/v1/tags',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      try {
        const [tag] = await app.db
          .insert(schema.tags)
          .values({ name: body.name, color: body.color, showOnSidebar: body.showOnSidebar, accountId: req.user.accountId })
          .returning();
        return reply.code(201).send(tag);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Tag já existe');
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/tags/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name.trim().toLowerCase();
      if (body.color !== undefined) patch.color = body.color;
      if (body.showOnSidebar !== undefined) patch.showOnSidebar = body.showOnSidebar;
      const [tag] = await app.db
        .update(schema.tags)
        .set(patch)
        .where(and(eq(schema.tags.id, id), eq(schema.tags.accountId, req.user.accountId)))
        .returning();
      if (!tag) return reply.notFound();
      return tag;
    },
  );

  app.delete(
    '/api/v1/tags/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.tags)
        .where(and(eq(schema.tags.id, id), eq(schema.tags.accountId, req.user.accountId)))
        .returning({ id: schema.tags.id });
      if (deleted.length === 0) return reply.notFound();
      return reply.code(204).send();
    },
  );
}
