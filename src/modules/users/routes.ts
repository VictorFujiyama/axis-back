import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { hashPassword, verifyPassword } from '../auth/password';
import { writeAudit } from '../../lib/audit';

const publicUser = (u: typeof schema.users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  avatarUrl: u.avatarUrl,
  lastSeenAt: u.lastSeenAt,
  createdAt: u.createdAt,
});

const createBody = z.object({
  email: z
    .string()
    .email()
    .transform((v) => v.trim().toLowerCase()),
  name: z.string().min(1).max(120),
  password: z.string().min(8),
  role: z.enum(['admin', 'supervisor', 'agent']).default('agent'),
});

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['admin', 'supervisor', 'agent']).optional(),
  avatarUrl: z.string().url().nullish(),
  password: z.string().min(8).optional(),
});

const statusBody = z.object({
  status: z.enum(['online', 'away', 'offline']),
});

const idParams = z.object({ id: z.string().uuid() });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // List users in current account
  app.get('/api/v1/users', { preHandler: app.requireAuth }, async (req) => {
    const rows = await app.db
      .select({ user: schema.users, accountRole: schema.accountUsers.role })
      .from(schema.accountUsers)
      .innerJoin(schema.users, eq(schema.accountUsers.userId, schema.users.id))
      .where(and(eq(schema.accountUsers.accountId, req.user.accountId), isNull(schema.users.deletedAt)));
    return { items: rows.map((r) => ({ ...publicUser(r.user), accountRole: r.accountRole })) };
  });

  // Me
  app.get('/api/v1/users/me', { preHandler: app.requireAuth }, async (req, reply) => {
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, req.user.sub))
      .limit(1);
    if (!user) return reply.notFound();
    return publicUser(user);
  });

  // Update my own profile (name, avatarUrl, password)
  app.patch(
    '/api/v1/users/me',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(120).optional(),
          avatarUrl: z.string().url().nullish(),
          currentPassword: z.string().min(1).optional(),
          newPassword: z.string().min(8).optional(),
        })
        .parse(req.body);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

      if (body.newPassword) {
        if (!body.currentPassword) {
          return reply.code(400).send({ error: 'currentPassword é obrigatório' });
        }
        const [user] = await app.db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, req.user.sub))
          .limit(1);
        if (!user) return reply.notFound();
        const ok = await verifyPassword(user.passwordHash, body.currentPassword);
        if (!ok) return reply.code(400).send({ error: 'Senha atual incorreta' });
        updates.passwordHash = await hashPassword(body.newPassword);
      }

      await app.db
        .update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, req.user.sub));
      const [updated] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, req.user.sub))
        .limit(1);
      return publicUser(updated!);
    },
  );

  // Update my own status (online/away/offline)
  app.patch(
    '/api/v1/users/me/status',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = statusBody.parse(req.body);
      await app.db
        .update(schema.users)
        .set({ status: body.status, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.users.id, req.user.sub));
      return reply.code(204).send();
    },
  );

  // Get by id
  app.get(
    '/api/v1/users/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      // Verify user belongs to the current account
      const [row] = await app.db
        .select({ user: schema.users, accountRole: schema.accountUsers.role })
        .from(schema.accountUsers)
        .innerJoin(schema.users, eq(schema.accountUsers.userId, schema.users.id))
        .where(and(eq(schema.accountUsers.accountId, req.user.accountId), eq(schema.users.id, id), isNull(schema.users.deletedAt)))
        .limit(1);
      if (!row) return reply.notFound();
      return { ...publicUser(row.user), accountRole: row.accountRole };
    },
  );

  // Create (admin only)
  app.post(
    '/api/v1/users',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      const passwordHash = await hashPassword(body.password);
      try {
        const [user] = await app.db
          .insert(schema.users)
          .values({
            email: body.email,
            name: body.name,
            role: body.role,
            passwordHash,
          })
          .returning();
        // Link user to the current account
        await app.db
          .insert(schema.accountUsers)
          .values({
            accountId: req.user.accountId,
            userId: user!.id,
            role: body.role,
            inviterId: req.user.sub,
          });
        void writeAudit(
          req,
          {
            action: 'user.created',
            entityType: 'user',
            entityId: user!.id,
            changes: { email: body.email, role: body.role },
          },
          { db: app.db, log: app.log },
        );
        return reply.code(201).send(publicUser(user!));
      } catch (err: any) {
        if (err?.code === '23505') return reply.conflict('Email já cadastrado');
        throw err;
      }
    },
  );

  // Update (admin only)
  app.patch(
    '/api/v1/users/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.role !== undefined) patch.role = body.role;
      if (body.avatarUrl !== undefined) patch.avatarUrl = body.avatarUrl;
      if (body.password) patch.passwordHash = await hashPassword(body.password);

      // Verify user belongs to the current account before updating
      const [membership] = await app.db
        .select({ userId: schema.accountUsers.userId })
        .from(schema.accountUsers)
        .where(and(eq(schema.accountUsers.accountId, req.user.accountId), eq(schema.accountUsers.userId, id)))
        .limit(1);
      if (!membership) return reply.notFound();

      const [user] = await app.db
        .update(schema.users)
        .set(patch)
        .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
        .returning();

      if (!user) return reply.notFound();
      void writeAudit(
        req,
        {
          action: 'user.updated',
          entityType: 'user',
          entityId: user.id,
          changes: {
            fields: Object.keys(body).filter((k) => k !== 'password'),
            passwordChanged: !!body.password,
          },
        },
        { db: app.db, log: app.log },
      );
      return publicUser(user);
    },
  );

  // Soft delete (admin only)
  app.delete(
    '/api/v1/users/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (id === req.user.sub) return reply.badRequest('Não pode deletar a si mesmo');
      // Verify user belongs to the current account
      const [membership] = await app.db
        .select({ userId: schema.accountUsers.userId })
        .from(schema.accountUsers)
        .where(and(eq(schema.accountUsers.accountId, req.user.accountId), eq(schema.accountUsers.userId, id)))
        .limit(1);
      if (!membership) return reply.notFound();
      const [user] = await app.db
        .update(schema.users)
        .set({ deletedAt: new Date() })
        .where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt)))
        .returning();
      if (!user) return reply.notFound();
      void writeAudit(
        req,
        {
          action: 'user.deleted',
          entityType: 'user',
          entityId: user.id,
          changes: { email: user.email, role: user.role },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );
}
