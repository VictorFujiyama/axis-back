import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { runActions, ActionSchema } from './execute';

const idParams = z.object({ id: z.string().uuid() });

const macroBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  actions: z.array(ActionSchema).min(1),
});

const ruleBody = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: z.enum(['message.created', 'conversation.created', 'conversation.assigned', 'tag.added']),
  conditions: z.array(z.record(z.unknown())).default([]),
  actions: z.array(ActionSchema).min(1),
  order: z.number().int().default(0),
});

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  // ===== MACROS =====
  app.get(
    '/api/v1/macros',
    { preHandler: app.requireAuth },
    async (req) => ({
      items: await app.db.select().from(schema.macros)
        .where(eq(schema.macros.accountId, req.user.accountId))
        .orderBy(asc(schema.macros.name)),
    }),
  );

  app.post(
    '/api/v1/macros',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = macroBody.parse(req.body);
      const [m] = await app.db
        .insert(schema.macros)
        .values({
          name: body.name,
          description: body.description,
          actions: body.actions,
          createdBy: req.user.sub,
          accountId: req.user.accountId,
        })
        .returning();
      return reply.code(201).send(m);
    },
  );

  app.patch(
    '/api/v1/macros/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = macroBody.partial().parse(req.body);
      const [m] = await app.db
        .update(schema.macros)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(schema.macros.id, id), eq(schema.macros.accountId, req.user.accountId)))
        .returning();
      if (!m) return reply.notFound();
      return m;
    },
  );

  app.delete(
    '/api/v1/macros/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.macros)
        .where(and(eq(schema.macros.id, id), eq(schema.macros.accountId, req.user.accountId)))
        .returning({ id: schema.macros.id });
      if (deleted.length === 0) return reply.notFound();
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/macros/:id/run',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = z.object({ conversationId: z.string().uuid() }).parse(req.body);
      const [macro] = await app.db
        .select()
        .from(schema.macros)
        .where(and(eq(schema.macros.id, id), eq(schema.macros.accountId, req.user.accountId)))
        .limit(1);
      if (!macro) return reply.notFound();
      const actions = ActionSchema.array().parse(macro.actions);
      const result = await runActions(actions, {
        conversationId: body.conversationId,
        actorUserId: req.user.sub,
        app,
      });
      return { applied: result.length };
    },
  );

  // ===== RULES =====
  app.get(
    '/api/v1/automation-rules',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => ({
      items: await app.db
        .select()
        .from(schema.automationRules)
        .where(eq(schema.automationRules.accountId, req.user.accountId))
        .orderBy(asc(schema.automationRules.order), asc(schema.automationRules.name)),
    }),
  );

  app.post(
    '/api/v1/automation-rules',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = ruleBody.parse(req.body);
      const [row] = await app.db
        .insert(schema.automationRules)
        .values({
          name: body.name,
          enabled: body.enabled,
          trigger: body.trigger,
          conditions: body.conditions,
          actions: body.actions,
          order: body.order,
          createdBy: req.user.sub,
          accountId: req.user.accountId,
        })
        .returning();
      return reply.code(201).send(row);
    },
  );

  app.patch(
    '/api/v1/automation-rules/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = ruleBody.partial().parse(req.body);
      const [row] = await app.db
        .update(schema.automationRules)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(schema.automationRules.id, id), eq(schema.automationRules.accountId, req.user.accountId)))
        .returning();
      if (!row) return reply.notFound();
      return row;
    },
  );

  app.delete(
    '/api/v1/automation-rules/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.automationRules)
        .where(and(eq(schema.automationRules.id, id), eq(schema.automationRules.accountId, req.user.accountId)))
        .returning({ id: schema.automationRules.id });
      if (deleted.length === 0) return reply.notFound();
      return reply.code(204).send();
    },
  );
}
