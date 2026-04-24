import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';

const idParams = z.object({ id: z.string().uuid() });
const createBody = z.object({
  name: z.string().min(1).max(120).transform((v) => v.trim()),
  description: z.string().max(500).optional(),
});
const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
});
const memberBody = z.object({ userId: z.string().uuid() });

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/teams',
    { preHandler: app.requireAuth },
    async (req) => {
      const rows = await app.db
        .select({
          id: schema.teams.id,
          name: schema.teams.name,
          description: schema.teams.description,
          memberCount: sql<number>`count(${schema.teamMembers.userId})::int`,
        })
        .from(schema.teams)
        .leftJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.teams.id))
        .where(eq(schema.teams.accountId, req.user.accountId))
        .groupBy(schema.teams.id);
      return { items: rows };
    },
  );

  app.get(
    '/api/v1/teams/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [team] = await app.db
        .select()
        .from(schema.teams)
        .where(and(eq(schema.teams.id, id), eq(schema.teams.accountId, req.user.accountId)))
        .limit(1);
      if (!team) return reply.notFound();
      const members = await app.db
        .select({
          userId: schema.teamMembers.userId,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.users.role,
          status: schema.users.status,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, id));
      return { ...team, members };
    },
  );

  app.post(
    '/api/v1/teams',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      try {
        const [team] = await app.db
          .insert(schema.teams)
          .values({ name: body.name, description: body.description, accountId: req.user.accountId })
          .returning();
        return reply.code(201).send(team);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('Time com esse nome já existe');
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/teams/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.description !== undefined) patch.description = body.description;
      const [team] = await app.db
        .update(schema.teams)
        .set(patch)
        .where(and(eq(schema.teams.id, id), eq(schema.teams.accountId, req.user.accountId)))
        .returning();
      if (!team) return reply.notFound();
      return team;
    },
  );

  app.delete(
    '/api/v1/teams/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.teams)
        .where(and(eq(schema.teams.id, id), eq(schema.teams.accountId, req.user.accountId)))
        .returning({ id: schema.teams.id });
      if (deleted.length === 0) return reply.notFound();
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/teams/:id/members',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = memberBody.parse(req.body);
      try {
        await app.db
          .insert(schema.teamMembers)
          .values({ teamId: id, userId: body.userId });
        return reply.code(204).send();
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.code(204).send();
        }
        throw err;
      }
    },
  );

  app.delete(
    '/api/v1/teams/:id/members/:userId',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), userId: z.string().uuid() })
        .parse(req.params);
      await app.db
        .delete(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, params.id),
            eq(schema.teamMembers.userId, params.userId),
          ),
        );
      return reply.code(204).send();
    },
  );

  // Assign conversation to a team — picks a member via round-robin and sets
  // both assignedTeamId and assignedUserId. If no online members, just sets team.
  app.post(
    '/api/v1/teams/:id/assign-conversation',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = z.object({ conversationId: z.string().uuid() }).parse(req.body);
      const [team] = await app.db
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(and(eq(schema.teams.id, id), eq(schema.teams.accountId, req.user.accountId)))
        .limit(1);
      if (!team) return reply.notFound();

      const members = await app.db
        .select({
          userId: schema.teamMembers.userId,
          status: schema.users.status,
        })
        .from(schema.teamMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, id))
        .orderBy(schema.teamMembers.userId);
      const online = members.filter((m) => m.status === 'online');
      const pool = online.length > 0 ? online : members;
      let chosen: string | null = null;
      if (pool.length > 0) {
        // Round-robin cursor per-team in Redis.
        const cursorKey = `team-rr:${id}`;
        const next = await app.redis.incr(cursorKey);
        await app.redis.expire(cursorKey, 7 * 24 * 3600);
        chosen = pool[(next - 1) % pool.length]!.userId;
      }

      const [updated] = await app.db
        .update(schema.conversations)
        .set({
          assignedTeamId: id,
          assignedUserId: chosen,
          updatedAt: new Date(),
        })
        .where(eq(schema.conversations.id, body.conversationId))
        .returning({ id: schema.conversations.id, assignedUserId: schema.conversations.assignedUserId });
      if (!updated) return reply.notFound();
      return { ...updated, assignedTeamId: id };
    },
  );
}
