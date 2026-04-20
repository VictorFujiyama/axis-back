import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const idParams = z.object({ id: z.string().uuid() });

const visibilityEnum = z.enum(['personal', 'inbox', 'global']);

const shortcutSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'use letras, números, _ ou -')
  .transform((v) => v.toLowerCase());

const createBody = z
  .object({
    name: z.string().min(1).max(120),
    shortcut: shortcutSchema,
    content: z.string().min(1).max(10_000),
    visibility: visibilityEnum,
    inboxId: z.string().uuid().optional(),
  })
  .refine(
    (v) => (v.visibility === 'inbox' ? !!v.inboxId : true),
    'inbox visibility requires inboxId',
  );

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  shortcut: shortcutSchema.optional(),
  content: z.string().min(1).max(10_000).optional(),
});

const listQuery = z.object({
  inboxId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(120).optional(),
});

export async function cannedRoutes(app: FastifyInstance): Promise<void> {
  // List canned responses visible to the current user.
  // Visible = global OR (personal && ownerId == me) OR (inbox && inboxId == query.inboxId)
  app.get(
    '/api/v1/canned-responses',
    { preHandler: app.requireAuth },
    async (req) => {
      const query = listQuery.parse(req.query);

      const visibilityConditions = [
        eq(schema.cannedResponses.visibility, 'global'),
        and(
          eq(schema.cannedResponses.visibility, 'personal'),
          eq(schema.cannedResponses.ownerId, req.user.sub),
        )!,
      ];
      if (query.inboxId) {
        visibilityConditions.push(
          and(
            eq(schema.cannedResponses.visibility, 'inbox'),
            eq(schema.cannedResponses.inboxId, query.inboxId),
          )!,
        );
      }

      const where = [or(...visibilityConditions)!, eq(schema.cannedResponses.accountId, req.user.accountId)];
      if (query.q) {
        const term = `%${query.q.toLowerCase()}%`;
        where.push(
          or(
            sql`lower(${schema.cannedResponses.shortcut}) like ${term}`,
            sql`lower(${schema.cannedResponses.name}) like ${term}`,
          )!,
        );
      }

      const rows = await app.db
        .select()
        .from(schema.cannedResponses)
        .where(and(...where))
        .orderBy(asc(schema.cannedResponses.shortcut));
      return { items: rows };
    },
  );

  // Create — any authenticated user can create personal. Only supervisor+ can create inbox/global.
  app.post(
    '/api/v1/canned-responses',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = createBody.parse(req.body);

      if (body.visibility !== 'personal' && req.user.role === 'agent') {
        return reply.forbidden('Apenas supervisor ou admin pode criar respostas globais/de inbox');
      }

      try {
        const [row] = await app.db
          .insert(schema.cannedResponses)
          .values({
            visibility: body.visibility,
            ownerId: body.visibility === 'personal' ? req.user.sub : null,
            inboxId: body.visibility === 'inbox' ? body.inboxId! : null,
            name: body.name.trim(),
            shortcut: body.shortcut,
            content: body.content,
            accountId: req.user.accountId,
          })
          .returning();
        return reply.code(201).send(row);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Atalho já existe nesse escopo');
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/canned-responses/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);

      const [existing] = await app.db
        .select()
        .from(schema.cannedResponses)
        .where(and(eq(schema.cannedResponses.id, id), eq(schema.cannedResponses.accountId, req.user.accountId)))
        .limit(1);
      if (!existing) return reply.notFound();

      // Personal canned can ONLY be mutated by its owner — not even admins.
      // Treats personal as truly personal (analogous to private notes).
      if (existing.visibility === 'personal') {
        if (existing.ownerId !== req.user.sub) return reply.forbidden();
      } else if (req.user.role === 'agent') {
        return reply.forbidden();
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.shortcut !== undefined) patch.shortcut = body.shortcut;
      if (body.content !== undefined) patch.content = body.content;
      try {
        const [row] = await app.db
          .update(schema.cannedResponses)
          .set(patch)
          .where(and(eq(schema.cannedResponses.id, id), eq(schema.cannedResponses.accountId, req.user.accountId)))
          .returning();
        return row;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Atalho já existe nesse escopo');
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/canned-responses/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [existing] = await app.db
        .select()
        .from(schema.cannedResponses)
        .where(and(eq(schema.cannedResponses.id, id), eq(schema.cannedResponses.accountId, req.user.accountId)))
        .limit(1);
      if (!existing) return reply.notFound();
      if (existing.visibility === 'personal') {
        if (existing.ownerId !== req.user.sub) return reply.forbidden();
      } else if (req.user.role === 'agent') {
        return reply.forbidden();
      }
      await app.db
        .delete(schema.cannedResponses)
        .where(eq(schema.cannedResponses.id, id));
      return reply.code(204).send();
    },
  );
}
