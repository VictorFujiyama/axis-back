import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { encryptJSON } from '../../crypto';
import { isAllowedWebhookUrl } from './webhook-url';
import { redactUrl, writeAudit } from '../../lib/audit';
import { eventBus } from '../../realtime/event-bus';
import { builtinBotConfigSchema } from './builtin-config';

const idParams = z.object({ id: z.string().uuid() });

const createBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    botType: z.enum(['external', 'builtin']).default('external'),
    webhookUrl: z.string().url().optional(),
    inboxId: z.string().uuid(),
    config: z.record(z.unknown()).optional(),
    /** API key for builtin bots (encrypted and stored in `secret` field). */
    apiKey: z.string().min(1).optional(),
  })
  .refine(
    (v) => v.botType !== 'external' || (v.webhookUrl && v.webhookUrl.length > 0),
    { message: 'webhookUrl is required for external bots', path: ['webhookUrl'] },
  )
  .refine(
    (v) => v.botType !== 'builtin' || (v.config && v.config.provider && v.config.model && v.config.systemPrompt),
    { message: 'config with provider, model, and systemPrompt is required for builtin bots', path: ['config'] },
  );

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  /** Updated API key for builtin bots. */
  apiKey: z.string().min(1).optional(),
});

type BotRow = typeof schema.bots.$inferSelect;

// Public representation never includes the secret (only returned at create / rotate).
function publicBot(row: BotRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    botType: row.botType,
    webhookUrl: row.webhookUrl,
    config: row.config,
    inboxId: row.inboxId,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function generateSecret(): string {
  return `blsk_${randomBytes(32).toString('hex')}`;
}

export async function botRoutes(app: FastifyInstance): Promise<void> {
  // Listing bots reveals webhook URLs — restrict to admin/supervisor.
  app.get(
    '/api/v1/bots',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const rows = await app.db.select().from(schema.bots)
        .where(eq(schema.bots.accountId, req.user.accountId));
      return { items: rows.map(publicBot) };
    },
  );

  app.get(
    '/api/v1/bots/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [bot] = await app.db
        .select()
        .from(schema.bots)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!bot) return reply.notFound();
      return publicBot(bot);
    },
  );

  app.post(
    '/api/v1/bots',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const body = createBody.parse(req.body);

      if (body.webhookUrl) {
        const urlCheck = isAllowedWebhookUrl(body.webhookUrl);
        if (!urlCheck.ok) return reply.badRequest(`webhookUrl inválido: ${urlCheck.reason}`);
      }

      // Validate builtin bot config
      let parsedConfig = body.config ?? {};
      if (body.botType === 'builtin') {
        try {
          parsedConfig = builtinBotConfigSchema.parse(body.config);
        } catch (err) {
          return reply.badRequest(`Configuração inválida para bot IA: ${err instanceof Error ? err.message : 'erro'}`);
        }
      }

      // Verify inbox exists and belongs to this account
      const [inbox] = await app.db
        .select({ id: schema.inboxes.id })
        .from(schema.inboxes)
        .where(
          and(eq(schema.inboxes.id, body.inboxId), eq(schema.inboxes.accountId, req.user.accountId)),
        )
        .limit(1);
      if (!inbox) return reply.badRequest('inboxId não encontrado');

      // For builtin bots, the secret stores the provider API key (encrypted).
      // For external bots, it's the HMAC/bearer secret.
      const secret = body.botType === 'builtin' && body.apiKey
        ? body.apiKey
        : generateSecret();
      const [bot] = await app.db
        .insert(schema.bots)
        .values({
          name: body.name,
          description: body.description,
          botType: body.botType,
          webhookUrl: body.webhookUrl ?? null,
          config: parsedConfig,
          inboxId: body.inboxId,
          secret: encryptJSON(secret),
          accountId: req.user.accountId,
        })
        .returning();
      app.log.info({ botId: bot!.id, actor: req.user.sub }, 'bot created');
      void writeAudit(
        req,
        {
          action: 'bot.created',
          entityType: 'bot',
          entityId: bot!.id,
          changes: {
            name: body.name,
            botType: body.botType,
            inboxId: body.inboxId,
            ...(body.webhookUrl ? { webhookOrigin: redactUrl(body.webhookUrl) } : {}),
          },
        },
        { db: app.db, log: app.log },
      );
      // Secret is returned ONLY here. Lost = rotate.
      // For builtin bots, the secret is the provider API key — don't echo it back.
      if (body.botType === 'builtin') {
        return reply.code(201).send(publicBot(bot!));
      }
      return reply.code(201).send({ ...publicBot(bot!), secret });
    },
  );

  app.patch(
    '/api/v1/bots/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      // Need to know botType for config validation
      const [existing] = await app.db
        .select({ botType: schema.bots.botType })
        .from(schema.bots)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .limit(1);
      if (!existing) return reply.notFound();

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.webhookUrl !== undefined) {
        if (body.webhookUrl !== null) {
          const urlCheck = isAllowedWebhookUrl(body.webhookUrl);
          if (!urlCheck.ok) return reply.badRequest(`webhookUrl inválido: ${urlCheck.reason}`);
        }
        patch.webhookUrl = body.webhookUrl;
      }
      if (body.config !== undefined) {
        if (existing.botType === 'builtin') {
          try {
            patch.config = builtinBotConfigSchema.parse(body.config);
          } catch (err) {
            return reply.badRequest(`Configuração inválida: ${err instanceof Error ? err.message : 'erro'}`);
          }
        } else {
          patch.config = body.config;
        }
      }
      if (body.apiKey !== undefined && existing.botType === 'builtin') {
        patch.secret = encryptJSON(body.apiKey);
      }
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      const [bot] = await app.db
        .update(schema.bots)
        .set(patch)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .returning();
      if (!bot) return reply.notFound();
      void writeAudit(
        req,
        {
          action: 'bot.updated',
          entityType: 'bot',
          entityId: bot.id,
          changes: {
            fields: Object.keys(body),
            ...(body.webhookUrl ? { webhookOrigin: redactUrl(body.webhookUrl) } : {}),
          },
        },
        { db: app.db, log: app.log },
      );
      return publicBot(bot);
    },
  );

  app.post(
    '/api/v1/bots/:id/rotate-secret',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const secret = generateSecret();
      const [bot] = await app.db
        .update(schema.bots)
        .set({ secret: encryptJSON(secret), updatedAt: new Date() })
        .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
        .returning();
      if (!bot) return reply.notFound();
      app.log.info({ botId: id, actor: req.user.sub }, 'bot.rotate_secret');
      void writeAudit(
        req,
        { action: 'bot.secret_rotated', entityType: 'bot', entityId: id },
        { db: app.db, log: app.log },
      );
      return { ...publicBot(bot), secret };
    },
  );

  app.delete(
    '/api/v1/bots/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const now = new Date();

      // Atomic: detach conversations + clear inbox default + delete bot
      let deletedId: string | null = null;
      let detachedConvs: { id: string; inboxId: string }[] = [];

      try {
        await app.db.transaction(async (tx) => {
          // Detach from conversations — set to pending so agents see them
          detachedConvs = await tx
            .update(schema.conversations)
            .set({
              assignedBotId: null,
              status: 'pending',
              waitingForAgentSince: now,
              updatedAt: now,
            })
            .where(eq(schema.conversations.assignedBotId, id))
            .returning({ id: schema.conversations.id, inboxId: schema.conversations.inboxId });

          // Clear defaultBotId from inboxes
          await tx
            .update(schema.inboxes)
            .set({ defaultBotId: null })
            .where(eq(schema.inboxes.defaultBotId, id));

          // Delete the bot
          const deleted = await tx
            .delete(schema.bots)
            .where(and(eq(schema.bots.id, id), eq(schema.bots.accountId, req.user.accountId)))
            .returning({ id: schema.bots.id });
          if (deleted.length === 0) throw new Error('not_found');
          deletedId = deleted[0]!.id;
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'not_found') return reply.notFound();
        throw err;
      }

      // Notify agents about detached conversations (outside tx)
      for (const conv of detachedConvs) {
        eventBus.emitEvent({
          type: 'conversation.assigned',
          inboxId: conv.inboxId,
          conversationId: conv.id,
          assignedUserId: null,
          assignedTeamId: null,
          assignedBotId: null,
        });
      }

      app.log.info({ botId: id, actor: req.user.sub, detachedConversations: detachedConvs.length }, 'bot deleted');
      void writeAudit(
        req,
        { action: 'bot.deleted', entityType: 'bot', entityId: id },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );
}
