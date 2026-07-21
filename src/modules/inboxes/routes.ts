import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { config as appConfig } from '../../config';
import { decryptJSON, encryptJSON, sha256 } from '../../crypto';
import { writeAudit } from '../../lib/audit';
import { applyAutoBotForInbox, type AutoBotReason, defaultModelFor } from './auto-bot';
import { backfillAssignedBotIdOnBotChange } from './backfill';
import { validateApiKey } from './api-key-validator';
import {
  deleteTelegramWebhook,
  generateTelegramWebhookSecret,
  getTelegramBotInfo,
  setTelegramWebhook,
  telegramWebhookUrl,
} from '../channels/telegram-setup';
import { setTwilioWebhook, twilioWebhookUrl } from '../channels/twilio-setup';
import {
  effectiveDailySendCap,
  effectiveTimezone,
  parseGmailConfig,
} from '../channels/gmail-config';
import {
  backlogDepth,
  currentSendCount,
  getPauseReason,
  isInboxPaused,
  promoteBacklog,
  resumeInbox,
} from '../channels/inbox-send-cap';
import { nextMidnightMs } from '../channels/inbox-cap-time';
import { inboxPromoteTotal } from '../../metrics';
import { QUEUE_NAMES, type EmailOutboundJob } from '../../queue';

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
  qualifierEnabled: z.boolean().optional(),
  defaultBotId: z.string().uuid().nullable().optional(),
  // playbook-in-axis (D13/D14/D20): playbook content + LLM credentials. `null`
  // clears; omitted (undefined) leaves the field untouched. min/max only apply
  // when a string is supplied (nullable bypasses the length checks).
  playbook: z.string().min(20).max(10000).nullable().optional(),
  botLlmApiKey: z.string().min(1).nullable().optional(),
  botLlmProvider: z.enum(['anthropic', 'openai']).nullable().optional(),
});

const patchQuery = z.object({ validateKey: z.enum(['true', 'false']).optional() });

const idParams = z.object({ id: z.string().uuid() });

const rotateTokenBody = z.object({ rotateHmac: z.boolean().optional() });

// Public widget token embedded in the install snippet: `wt_<48 hex>`. Matches
// the format the website wizard generates client-side.
function generateWidgetToken(): string {
  return `wt_${randomBytes(24).toString('hex')}`;
}

const memberBody = z.object({
  userIds: z.array(z.string().uuid()).min(1),
});

// Public representation — omit encrypted secrets blob and indicate configured.
// `playbookContent` is only loaded on the detail/PATCH paths; when omitted the
// `playbook` field is left off the response (it isn't needed in list views).
function publicInbox(
  row: typeof schema.inboxes.$inferSelect,
  playbookContent?: string | null,
) {
  const config = (row.config ?? {}) as Record<string, unknown>;
  const provider = typeof config.provider === 'string' ? config.provider : undefined;
  const webhookAutoConfigured = config.webhookAutoConfigured === true;

  // Callback URL the user needs to paste into the channel provider (Twilio,
  // etc). Null when PUBLIC_API_URL is unset or when the channel has no
  // inbound webhook (bot channels handle it internally).
  let callbackWebhookUrl: string | null = null;
  if (appConfig.PUBLIC_API_URL) {
    const base = appConfig.PUBLIC_API_URL.replace(/\/$/, '');
    if (row.channelType === 'whatsapp' && (provider === 'twilio' || !provider)) {
      callbackWebhookUrl = `${base}/webhooks/whatsapp/${row.id}`;
    } else if (row.channelType === 'sms') {
      callbackWebhookUrl = `${base}/webhooks/sms/${row.id}`;
    } else if (row.channelType === 'telegram') {
      callbackWebhookUrl = `${base}/webhooks/telegram/${row.id}`;
    }
  }

  return {
    id: row.id,
    name: row.name,
    channelType: row.channelType,
    config: row.config,
    defaultBotId: row.defaultBotId,
    enabled: row.enabled,
    qualifierEnabled: row.qualifierEnabled,
    secretsConfigured: row.secrets !== null,
    callbackWebhookUrl,
    webhookAutoConfigured,
    botLlmApiKeyConfigured: row.botLlmApiKeyEnc != null,
    botLlmProvider: row.botLlmProvider ?? null,
    ...(playbookContent !== undefined ? { playbook: playbookContent } : {}),
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
      return { items: rows.map((r) => publicInbox(r)) };
    }
    const allowed = await inboxIdsForUser(app, req.user.sub, req.user.accountId);
    if (allowed.length === 0) return { items: [] };
    const rows = await app.db
      .select()
      .from(schema.inboxes)
      .where(
        and(isNull(schema.inboxes.deletedAt), eq(schema.inboxes.accountId, req.user.accountId), inArray(schema.inboxes.id, allowed)),
      );
    return { items: rows.map((r) => publicInbox(r)) };
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
      const [pb] = await app.db
        .select({ content: schema.inboxPlaybooks.content })
        .from(schema.inboxPlaybooks)
        .where(eq(schema.inboxPlaybooks.inboxId, inbox.id))
        .limit(1);
      return publicInbox(inbox, pb?.content ?? null);
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

      // Webchat inboxes get a server-issued hmacToken so the customer can sign
      // visitor identities (identifier_hash). It lives in secrets like other
      // channel credentials; the caller never supplies it.
      if (body.channelType === 'webchat' && typeof secrets.hmacToken !== 'string') {
        secrets.hmacToken = randomBytes(32).toString('hex');
      }

      let [inbox] = await app.db
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

      // For Twilio channels (whatsapp/sms), hit the Twilio REST API to point
      // the inbound webhook at our server — mirrors Chatwoot's
      // Twilio::WebhookSetupService. Awaited so the API response reflects the
      // actual config state; finish page branches on `webhookAutoConfigured`.
      if (
        (body.channelType === 'whatsapp' || body.channelType === 'sms') &&
        typeof secrets.authToken === 'string'
      ) {
        const provider = (config.provider as string | undefined) ?? 'twilio';
        if (provider === 'twilio' && typeof config.accountSid === 'string') {
          const webhookUrl = twilioWebhookUrl(body.channelType, inbox!.id);
          if (!webhookUrl) {
            app.log.warn(
              { inboxId: inbox!.id, channel: body.channelType },
              'twilio inbox created but PUBLIC_API_URL not set — webhook not registered',
            );
          } else {
            const r = await setTwilioWebhook({
              accountSid: config.accountSid,
              authToken: secrets.authToken,
              webhookUrl,
              fromNumber:
                typeof config.fromNumber === 'string' ? config.fromNumber : undefined,
              messagingServiceSid:
                typeof config.messagingServiceSid === 'string'
                  ? config.messagingServiceSid
                  : undefined,
              channel: body.channelType,
              log: app.log,
            });
            if (r.ok) {
              app.log.info(
                { inboxId: inbox!.id, target: r.target, webhookUrl },
                'twilio webhook registered',
              );
              // Twilio already accepted the webhook — the response must reflect
              // that even if the follow-up DB UPDATE fails. Reflect the truth
              // in memory so the finish page shows the success banner; a failed
              // UPDATE is logged and the caller (admin) can see the warning.
              const updatedConfig = { ...config, webhookAutoConfigured: true };
              try {
                const [updated] = await app.db
                  .update(schema.inboxes)
                  .set({ config: updatedConfig })
                  .where(eq(schema.inboxes.id, inbox!.id))
                  .returning();
                if (updated) inbox = updated;
              } catch (err) {
                app.log.error(
                  { err, inboxId: inbox!.id },
                  'twilio webhook configured but DB UPDATE failed — state drift',
                );
                inbox = { ...inbox!, config: updatedConfig };
              }
            }
          }
        }
      }

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
      const query = patchQuery.parse(req.query);
      // safeParse so zod min/max violations answer 400 explicitly (no global
      // ZodError handler in this app — an unhandled throw would 500).
      const parsed = updateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const body = parsed.data;

      // playbook-in-axis fields present? (D20 transactional path)
      const touchesPlaybookFeature =
        body.playbook !== undefined ||
        body.botLlmApiKey !== undefined ||
        body.botLlmProvider !== undefined;

      // Feature flag gate (D37): block playbook/key changes during a rollback.
      if (touchesPlaybookFeature && !appConfig.PLAYBOOK_IN_AXIS_ENABLED) {
        return reply.badRequest('feature disabled');
      }

      // Key ↔ provider must travel together (D14): a non-null key requires a
      // non-null provider and vice versa.
      const keyTruthy = body.botLlmApiKey != null;
      const providerTruthy = body.botLlmProvider != null;
      if (keyTruthy !== providerTruthy) {
        return reply.badRequest('botLlmApiKey and botLlmProvider must be set together');
      }

      // Opt-in smoke validation (D17/D43) — runs BEFORE the transaction so a
      // bad key never mutates state.
      if (query.validateKey === 'true' && keyTruthy && providerTruthy) {
        const result = await validateApiKey(
          body.botLlmProvider!,
          body.botLlmApiKey!,
          defaultModelFor(body.botLlmProvider!),
        );
        if (!result.ok) {
          if (result.kind === 'auth') return reply.badRequest('invalid api key');
          return reply.code(502).send({ error: 'provider validation failed', message: result.message });
        }
      }

      // Base inbox update — note: defaultBotId / botLlmApiKeyEnc / botLlmProvider
      // are owned by applyAutoBotForInbox (D20), so they are NOT set here.
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.config !== undefined) patch.config = body.config;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.qualifierEnabled !== undefined) patch.qualifierEnabled = body.qualifierEnabled;
      if (body.secrets !== undefined) patch.secrets = encryptJSON(body.secrets);
      if (body.defaultBotId !== undefined) patch.defaultBotId = body.defaultBotId;

      let inbox: typeof schema.inboxes.$inferSelect | undefined;
      let previousDefaultBotId: string | null = null;
      await app.db.transaction(async (tx) => {
        // Capture the current default_bot_id BEFORE the update so we can detect
        // a null→bot transition (or any change) and backfill assigned_bot_id on
        // existing open threads. Without this the operator sets a bot but live
        // conversations stay assigned_bot_id=null and the bot chat flow
        // silently skips them — bug #A2 root cause (see backfill.ts).
        const [beforeRow] = await tx
          .select({ defaultBotId: schema.inboxes.defaultBotId })
          .from(schema.inboxes)
          .where(and(eq(schema.inboxes.id, id), eq(schema.inboxes.accountId, req.user.accountId), isNull(schema.inboxes.deletedAt)))
          .limit(1);
        previousDefaultBotId = beforeRow?.defaultBotId ?? null;

        const [updated] = await tx
          .update(schema.inboxes)
          .set(patch)
          .where(and(eq(schema.inboxes.id, id), eq(schema.inboxes.accountId, req.user.accountId), isNull(schema.inboxes.deletedAt)))
          .returning();
        if (!updated) return; // inbox missing — handled after tx, nothing persisted.
        inbox = updated;

        // Upsert / clear the playbook row (D1, version bump + fresh etag).
        if (body.playbook !== undefined) {
          if (body.playbook === null) {
            await tx.delete(schema.inboxPlaybooks).where(eq(schema.inboxPlaybooks.inboxId, id));
          } else {
            const etag = sha256(body.playbook).slice(0, 16);
            await tx
              .insert(schema.inboxPlaybooks)
              .values({ inboxId: id, content: body.playbook, etag })
              .onConflictDoUpdate({
                target: schema.inboxPlaybooks.inboxId,
                set: {
                  content: body.playbook,
                  etag,
                  version: sql`${schema.inboxPlaybooks.version} + 1`,
                  updatedAt: new Date(),
                },
              });
          }
        }

        // Auto-bot lifecycle (single writer of key columns + defaultBotId, D20).
        if (touchesPlaybookFeature) {
          let reason: AutoBotReason = 'enable';
          if (body.botLlmApiKey === null || body.playbook === null) reason = 'disable';
          else if (body.botLlmApiKey != null) reason = 'rotate-key';
          await applyAutoBotForInbox(tx, {
            inboxId: id,
            accountId: req.user.accountId,
            actorUserId: req.user.sub,
            reason,
            newApiKey: body.botLlmApiKey,
            newProvider: body.botLlmProvider,
          });
        }

        // Bug #A2 backfill — if defaultBotId just transitioned to a real bot
        // (from null OR from a different bot), adopt any open/pending/snoozed
        // threads that never had a bot attached. Re-read the row inside the
        // same tx because applyAutoBotForInbox may have changed defaultBotId
        // above (it owns the auto-bot lifecycle writes per D20).
        // Wrapped: backfill is a side effect on top of a successful inbox
        // update. If it fails, we log warn but let the tx commit — the primary
        // write must not roll back over a bonus adoption.
        try {
          const [afterRow] = await tx
            .select({ defaultBotId: schema.inboxes.defaultBotId })
            .from(schema.inboxes)
            .where(eq(schema.inboxes.id, id))
            .limit(1);
          const currentBotId = afterRow?.defaultBotId ?? null;
          if (currentBotId && currentBotId !== previousDefaultBotId) {
            const adopted = await backfillAssignedBotIdOnBotChange(tx, id, currentBotId);
            if (adopted > 0) {
              app.log.info(
                { inboxId: id, botId: currentBotId, adopted, previousBotId: previousDefaultBotId },
                'inboxes: backfilled assigned_bot_id on open threads after default_bot_id change',
              );
            }
          }
        } catch (err) {
          app.log.warn({ err, inboxId: id }, 'inboxes: assigned_bot_id backfill failed (non-fatal)');
        }
      });

      if (!inbox) return reply.notFound();

      // Re-read the inbox so the response reflects applyAutoBot's writes
      // (defaultBotId, key columns) committed inside the transaction.
      const [fresh] = await app.db
        .select()
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, id))
        .limit(1);
      const finalInbox = fresh ?? inbox;

      const [pb] = await app.db
        .select({ content: schema.inboxPlaybooks.content })
        .from(schema.inboxPlaybooks)
        .where(eq(schema.inboxPlaybooks.inboxId, id))
        .limit(1);

      void writeAudit(
        req,
        {
          action: 'inbox.updated',
          entityType: 'inbox',
          entityId: finalInbox.id,
          changes: {
            fields: Object.keys(body).filter((k) => k !== 'secrets' && k !== 'botLlmApiKey'),
            secretsChanged: body.secrets !== undefined,
            playbookChanged: body.playbook !== undefined,
            keyChanged: body.botLlmApiKey !== undefined,
          },
        },
        { db: app.db, log: app.log },
      );
      return publicInbox(finalInbox, pb?.content ?? null);
    },
  );

  app.delete(
    '/api/v1/inboxes/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      let inbox: typeof schema.inboxes.$inferSelect | undefined;
      await app.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.inboxes)
          .set({ deletedAt: new Date() })
          .where(and(eq(schema.inboxes.id, id), eq(schema.inboxes.accountId, req.user.accountId), isNull(schema.inboxes.deletedAt)))
          .returning();
        if (!updated) return; // inbox missing/already deleted — handled after tx.
        inbox = updated;

        // Soft-delete doesn't fire the CASCADE FK, so disable the auto-bot and
        // clear defaultBotId application-side (D33). The auto-bot reads the now
        // deleted inbox within this tx → active=false → disable.
        await applyAutoBotForInbox(tx, {
          inboxId: id,
          accountId: req.user.accountId,
          actorUserId: req.user.sub,
          reason: 'inbox-deleted',
        });
      });
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

  // Rotate the webchat widget token (D14). Regenerates `config.widgetToken` and,
  // when `{ rotateHmac: true }`, the `hmacToken` secret. Rotation breaks active
  // installs — the UI confirms before calling. Scoped to inbox members.
  app.post(
    '/api/v1/inboxes/:id/webchat/rotate-token',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const parsed = rotateTokenBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { rotateHmac } = parsed.data;

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(
          and(
            eq(schema.inboxes.id, id),
            eq(schema.inboxes.accountId, req.user.accountId),
            isNull(schema.inboxes.deletedAt),
          ),
        )
        .limit(1);
      if (!inbox) return reply.notFound();
      if (inbox.channelType !== 'webchat') {
        return reply.badRequest('not a webchat inbox');
      }
      if (req.user.role !== 'admin' && req.user.role !== 'supervisor') {
        const allowed = await inboxIdsForUser(app, req.user.sub, req.user.accountId);
        if (!allowed.includes(inbox.id)) return reply.forbidden('Not a member of this inbox');
      }

      const widgetToken = generateWidgetToken();
      const nextConfig = {
        ...((inbox.config ?? {}) as Record<string, unknown>),
        widgetToken,
      };

      let nextSecrets = inbox.secrets;
      if (rotateHmac) {
        const current = inbox.secrets
          ? (decryptJSON(inbox.secrets) as Record<string, unknown>)
          : {};
        nextSecrets = encryptJSON({ ...current, hmacToken: randomBytes(32).toString('hex') });
      }

      const [updated] = await app.db
        .update(schema.inboxes)
        .set({ config: nextConfig, secrets: nextSecrets, updatedAt: new Date() })
        .where(
          and(
            eq(schema.inboxes.id, id),
            eq(schema.inboxes.accountId, req.user.accountId),
            isNull(schema.inboxes.deletedAt),
          ),
        )
        .returning();
      if (!updated) return reply.notFound();

      void writeAudit(
        req,
        {
          action: 'inbox.webchat_token_rotated',
          entityType: 'inbox',
          entityId: id,
          changes: { rotatedHmac: rotateHmac === true },
        },
        { db: app.db, log: app.log },
      );

      return reply.send({ widgetToken, rotatedHmac: rotateHmac === true });
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

  // Phase 13 — daily-send-cap live status. Used by the inbox settings UI to
  // show progress, banner state, and backlog depth without reloading config.
  app.get(
    '/api/v1/inboxes/:id/today-send-count',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [inbox] = await app.db
        .select({ id: schema.inboxes.id, config: schema.inboxes.config })
        .from(schema.inboxes)
        .where(
          and(
            eq(schema.inboxes.id, id),
            eq(schema.inboxes.accountId, req.user.accountId),
            isNull(schema.inboxes.deletedAt),
          ),
        )
        .limit(1);
      if (!inbox) return reply.notFound();

      const cfg = parseGmailConfig(inbox.config);
      const cap = cfg.provider === 'gmail' ? effectiveDailySendCap(cfg) : null;
      const tz = effectiveTimezone(cfg);
      const nowMs = Date.now();
      const [sent, paused, reason, depth] = await Promise.all([
        currentSendCount(app.redis, inbox.id, tz, nowMs),
        isInboxPaused(app.redis, inbox.id),
        getPauseReason(app.redis, inbox.id),
        backlogDepth(app.redis, inbox.id),
      ]);
      return {
        sent,
        cap,
        timezone: tz,
        paused,
        pauseReason: reason,
        backlogDepth: depth,
        nextResetAt: cap == null ? null : new Date(nextMidnightMs(tz, nowMs)).toISOString(),
      };
    },
  );

  // Phase 13 — UI signals that cap/tz changed. Lifts paused if cap > 0 and
  // promotes the backlog with fresh jitter so delayed jobs fire immediately.
  // Idempotent: re-calling after the backlog drains is a no-op.
  app.post(
    '/api/v1/inboxes/:id/cap-changed',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [inbox] = await app.db
        .select({ id: schema.inboxes.id, config: schema.inboxes.config })
        .from(schema.inboxes)
        .where(
          and(
            eq(schema.inboxes.id, id),
            eq(schema.inboxes.accountId, req.user.accountId),
            isNull(schema.inboxes.deletedAt),
          ),
        )
        .limit(1);
      if (!inbox) return reply.notFound();
      const cfg = parseGmailConfig(inbox.config);
      const cap = cfg.provider === 'gmail' ? effectiveDailySendCap(cfg) : null;
      if (cap != null && cap > 0) {
        // Only clear paused when the pause came from cap=0 (or wasn't set).
        // needs-reauth and manual pauses are NOT lifted by a cap bump — those
        // require their own action (reauth Gmail; explicit unpause).
        const reason = await getPauseReason(app.redis, inbox.id);
        if (reason === null || reason === 'cap-zero') {
          await resumeInbox(app.redis, inbox.id);
        }
        const queue = app.queues.getQueue<EmailOutboundJob>(QUEUE_NAMES.EMAIL_OUTBOUND);
        const result = await promoteBacklog(app.redis, queue, inbox.id);
        if (result.promoted > 0) inboxPromoteTotal.inc(result.promoted);
        return result;
      }
      return { promoted: 0, skipped: 0, removed: 0 };
    },
  );
}
