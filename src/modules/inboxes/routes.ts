import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON, encryptJSON } from '../../crypto';
import { writeAudit } from '../../lib/audit';
import {
  deleteTelegramWebhook,
  generateTelegramWebhookSecret,
  getTelegramBotInfo,
  setTelegramWebhook,
  telegramWebhookUrl,
} from '../channels/telegram-setup';

const channelTypes = [
  'whatsapp',
  'email',
  'instagram',
  'messenger',
  'telegram',
  'webchat',
  'sms',
  'api',
] as const;

const createBody = z.object({
  name: z.string().min(1).max(120),
  channelType: z.enum(channelTypes),
  config: z.record(z.unknown()).default({}),
  // Sensitive: tokens, API keys, passwords. Stored encrypted, never returned.
  secrets: z.record(z.unknown()).optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
  secrets: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  defaultBotId: z.string().uuid().nullable().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const memberBody = z.object({
  userIds: z.array(z.string().uuid()).min(1),
});

// Public representation — omit encrypted secrets blob and indicate configured.
function publicInbox(row: typeof schema.inboxes.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    channelType: row.channelType,
    config: row.config,
    defaultBotId: row.defaultBotId,
    enabled: row.enabled,
    secretsConfigured: row.secrets !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// For non-admin users, restrict listing/read to inboxes they are members of.
async function inboxIdsForUser(app: FastifyInstance, userId: string, accountId?: string): Promise<string[]> {
  if (accountId) {
    const rows = await app.db
      .select({ inboxId: schema.inboxMembers.inboxId })
      .from(schema.inboxMembers)
      .innerJoin(schema.inboxes, eq(schema.inboxes.id, schema.inboxMembers.inboxId))
      .where(and(eq(schema.inboxMembers.userId, userId), eq(schema.inboxes.accountId, accountId)));
    return rows.map((r) => r.inboxId);
  }
  const rows = await app.db
    .select({ inboxId: schema.inboxMembers.inboxId })
    .from(schema.inboxMembers)
    .where(eq(schema.inboxMembers.userId, userId));
  return rows.map((r) => r.inboxId);
}

export async function inboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/inboxes', { preHandler: app.requireAuth }, async (req) => {
    const isAdmin = req.user.role === 'admin' || req.user.role === 'supervisor';
    const base = app.db
      .select()
      .from(schema.inboxes)
      .where(and(isNull(schema.inboxes.deletedAt), eq(schema.inboxes.accountId, req.user.accountId)));
    if (isAdmin) {
      const rows = await base;
      return { items: rows.map(publicInbox) };
    }
    const allowed = await inboxIdsForUser(app, req.user.sub, req.user.accountId);
    if (allowed.length === 0) return { items: [] };
    const rows = await app.db
      .select()
      .from(schema.inboxes)
      .where(
        and(isNull(schema.inboxes.deletedAt), eq(schema.inboxes.accountId, req.user.accountId), inArray(schema.inboxes.id, allowed)),
      );
    return { items: rows.map(publicInbox) };
  });

  app.get(
    '/api/v1/inboxes/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, id), eq(schema.inboxes.accountId, req.user.accountId), isNull(schema.inboxes.deletedAt)))
        .limit(1);
      if (!inbox) return reply.notFound();

      if (req.user.role !== 'admin' && req.user.role !== 'supervisor') {
        const allowed = await inboxIdsForUser(app, req.user.sub, req.user.accountId);
        if (!allowed.includes(inbox.id)) return reply.forbidden('Not a member of this inbox');
      }
      return publicInbox(inbox);
    },
  );

  app.post(
    '/api/v1/inboxes',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const body = createBody.parse(req.body);

      // For Telegram we auto-generate a webhookSecret if the caller didn't
      // provide one. This closes the auth gap (signed webhooks only) and
      // removes the need for the user to curl setWebhook manually.
      const secrets: Record<string, unknown> = { ...(body.secrets ?? {}) };
      const config: Record<string, unknown> = { ...body.config };
      let resolvedName = body.name;

      if (body.channelType === 'telegram') {
        if (typeof secrets.botToken !== 'string' || !secrets.botToken) {
          return reply.badRequest('Telegram inbox requires a botToken');
        }
        // Validate the token by calling getMe on the backend (browser can't
        // hit api.telegram.org due to CORS). Use the returned name as the
        // inbox name when possible and store bot metadata on config.
        const botInfo = await getTelegramBotInfo(secrets.botToken, app.log);
        if (!botInfo) {
          return reply.badRequest('Invalid Telegram bot token');
        }
        resolvedName = botInfo.firstName || body.name;
        config.botId = botInfo.id;
        if (botInfo.username) config.botUsername = botInfo.username;
        if (!secrets.webhookSecret) {
          secrets.webhookSecret = generateTelegramWebhookSecret();
        }
      }

      const [inbox] = await app.db
        .insert(schema.inboxes)
        .values({
          name: resolvedName,
          channelType: body.channelType,
          config,
          secrets: Object.keys(secrets).length > 0 ? encryptJSON(secrets) : null,
          accountId: req.user.accountId,
        })
        .returning();
      void writeAudit(
        req,
        {
          action: 'inbox.created',
          entityType: 'inbox',
          entityId: inbox!.id,
          changes: { name: body.name, channelType: body.channelType },
        },
        { db: app.db, log: app.log },
      );

      // Fire-and-forget: register webhook with Telegram so inbound messages
      // start flowing. If this fails (bad token, API down, PUBLIC_API_URL
      // missing), we still return 201 so the user can retry via PATCH later.
      if (body.channelType === 'telegram' && typeof secrets.botToken === 'string') {
        const url = telegramWebhookUrl(inbox!.id);
        if (!url) {
          app.log.warn(
            { inboxId: inbox!.id },
            'telegram inbox created but PUBLIC_API_URL not set — webhook not registered',
          );
        } else {
          void setTelegramWebhook({
            botToken: secrets.botToken as string,
            webhookUrl: url,
            secretToken: secrets.webhookSecret as string,
            log: app.log,
          }).then((r) => {
            if (!r.ok) {
              app.log.warn(
                { inboxId: inbox!.id, description: r.description },
                'telegram setWebhook failed on create — user can retry',
              );
            } else {
              app.log.info({ inboxId: inbox!.id, url }, 'telegram webhook registered');
            }
          });
        }
      }

      return reply.code(201).send(publicInbox(inbox!));
    },
  );

  app.patch(
    '/api/v1/inboxes/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.config !== undefined) patch.config = body.config;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.secrets !== undefined) patch.secrets = encryptJSON(body.secrets);
      if (body.defaultBotId !== undefined) patch.defaultBotId = body.defaultBotId;
      const [inbox] = await app.db
        .update(schema.inboxes)
        .set(patch)
        .where(and(eq(schema.inboxes.id, id), eq(schema.inboxes.accountId, req.user.accountId), isNull(schema.inboxes.deletedAt)))
        .returning();
      if (!inbox) return reply.notFound();
      void writeAudit(
        req,
        {
          action: 'inbox.updated',
          entityType: 'inbox',
          entityId: inbox.id,
          changes: {
            fields: Object.keys(body).filter((k) => k !== 'secrets'),
            secretsChanged: body.secrets !== undefined,
          },
        },
        { db: app.db, log: app.log },
      );
      return publicInbox(inbox);
    },
  );

  app.delete(
    '/api/v1/inboxes/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [inbox] = await app.db
        .update(schema.inboxes)
        .set({ deletedAt: new Date() })
        .where(and(eq(schema.inboxes.id, id), eq(schema.inboxes.accountId, req.user.accountId), isNull(schema.inboxes.deletedAt)))
        .returning();
      if (!inbox) return reply.notFound();

      // Unregister the Telegram webhook so the bot stops posting to our
      // soft-deleted inbox. Fire-and-forget; if Telegram is unreachable
      // the webhook eventually times out on their side anyway.
      if (inbox.channelType === 'telegram' && inbox.secrets) {
        try {
          const decrypted = decryptJSON(inbox.secrets) as { botToken?: unknown };
          if (typeof decrypted.botToken === 'string') {
            void deleteTelegramWebhook({ botToken: decrypted.botToken, log: app.log });
          }
        } catch (err) {
          app.log.warn({ err, inboxId: inbox.id }, 'telegram delete webhook: cannot decrypt secrets');
        }
      }

      void writeAudit(
        req,
        {
          action: 'inbox.deleted',
          entityType: 'inbox',
          entityId: inbox.id,
          changes: { name: inbox.name, channelType: inbox.channelType },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );

  // Members
  app.get(
    '/api/v1/inboxes/:id/members',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      if (req.user.role !== 'admin' && req.user.role !== 'supervisor') {
        const allowed = await inboxIdsForUser(app, req.user.sub, req.user.accountId);
        if (!allowed.includes(id)) return reply.forbidden('Not a member of this inbox');
      }
      const rows = await app.db
        .select({
          userId: schema.inboxMembers.userId,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.users.role,
        })
        .from(schema.inboxMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.inboxMembers.userId))
        .where(eq(schema.inboxMembers.inboxId, id));
      return { items: rows };
    },
  );

  app.post(
    '/api/v1/inboxes/:id/members',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = memberBody.parse(req.body);
      await app.db
        .insert(schema.inboxMembers)
        .values(body.userIds.map((userId) => ({ inboxId: id, userId })))
        .onConflictDoNothing();
      void writeAudit(
        req,
        {
          action: 'inbox.members_added',
          entityType: 'inbox',
          entityId: id,
          changes: { userIds: body.userIds },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/v1/inboxes/:id/members/:userId',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), userId: z.string().uuid() })
        .parse(req.params);
      await app.db
        .delete(schema.inboxMembers)
        .where(
          and(
            eq(schema.inboxMembers.inboxId, params.id),
            eq(schema.inboxMembers.userId, params.userId),
          ),
        );
      void writeAudit(
        req,
        {
          action: 'inbox.member_removed',
          entityType: 'inbox',
          entityId: params.id,
          changes: { userId: params.userId },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );
}
