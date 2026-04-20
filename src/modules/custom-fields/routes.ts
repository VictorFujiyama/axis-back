import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const idParams = z.object({ id: z.string().uuid() });
const KEY_RE = /^[a-z][a-z0-9_]*$/;

const createBody = z.object({
  key: z.string().min(1).max(60).regex(KEY_RE, 'key: lowercase alfanumérico com _'),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'number', 'date', 'select', 'multi_select', 'boolean']),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
  order: z.number().int().default(0),
});

const updateBody = createBody.partial().omit({ key: true });

export async function customFieldRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/custom-field-defs',
    { preHandler: app.requireAuth },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.customFieldDefs)
        .where(and(isNull(schema.customFieldDefs.deletedAt), eq(schema.customFieldDefs.accountId, req.user.accountId)))
        .orderBy(asc(schema.customFieldDefs.order), asc(schema.customFieldDefs.label));
      return { items: rows };
    },
  );

  app.post(
    '/api/v1/custom-field-defs',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      if ((body.type === 'select' || body.type === 'multi_select') && body.options.length === 0) {
        return reply.badRequest('select types require options');
      }
      try {
        const [row] = await app.db
          .insert(schema.customFieldDefs)
          .values({ ...body, accountId: req.user.accountId })
          .returning();
        return reply.code(201).send(row);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Campo com essa key já existe');
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/custom-field-defs/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const [row] = await app.db
        .update(schema.customFieldDefs)
        .set(body)
        .where(and(eq(schema.customFieldDefs.id, id), eq(schema.customFieldDefs.accountId, req.user.accountId)))
        .returning();
      if (!row) return reply.notFound();
      return row;
    },
  );

  // Soft-delete preserves contact data; reactivate by clearing deletedAt.
  app.delete(
    '/api/v1/custom-field-defs/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .update(schema.customFieldDefs)
        .set({ deletedAt: new Date() })
        .where(and(eq(schema.customFieldDefs.id, id), eq(schema.customFieldDefs.accountId, req.user.accountId)))
        .returning({ id: schema.customFieldDefs.id });
      if (!row) return reply.notFound();
      return reply.code(204).send();
    },
  );
}
