import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { decryptJSON, encryptJSON } from '../../crypto';
import { isAllowedWebhookUrl } from '../bots/webhook-url';
import { canAccessConversation, userInboxIds } from '../conversations/access';
import { eventBus } from '../../realtime/event-bus';
import { safeFetch, SafeFetchError } from '../../lib/safe-fetch';
import { redactUrl, writeAudit } from '../../lib/audit';

const idParams = z.object({ id: z.string().uuid() });

const formFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'use snake_case sem acentos'),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'textarea', 'select', 'number']),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  placeholder: z.string().max(200).optional(),
  maxLength: z.number().int().positive().max(2000).optional(),
});

const formSchemaSchema = z.object({
  fields: z.array(formFieldSchema).max(20).default([]),
});

const createBody = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_-]*$/, 'use slug minúsculo'),
  label: z.string().min(1).max(120),
  icon: z.string().max(60).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  formSchema: formSchemaSchema.default({ fields: [] }),
  webhookUrl: z.string().url(),
  inboxId: z.string().uuid().nullable().optional(),
  requiresRole: z.enum(['admin', 'supervisor', 'agent']).default('agent'),
  postNoteOnSuccess: z.boolean().default(true),
});

const updateBody = createBody.partial().omit({ name: true });

function generateSecret(): string {
  return `actsk_${randomBytes(32).toString('hex')}`;
}

function publicAction(
  row: typeof schema.customActions.$inferSelect,
  opts: { includeWebhookUrl: boolean } = { includeWebhookUrl: false },
) {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    icon: row.icon,
    color: row.color,
    formSchema: row.formSchema,
    // webhookUrl is sensitive (may contain tokens in path/query): admins/supervisors only.
    ...(opts.includeWebhookUrl ? { webhookUrl: row.webhookUrl } : {}),
    inboxId: row.inboxId,
    requiresRole: row.requiresRole,
    postNoteOnSuccess: row.postNoteOnSuccess,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const runBody = z.object({
  conversationId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  formData: z.record(z.unknown()).default({}),
});

interface RunResponse {
  status: 'success' | 'error';
  message?: string;
  privateNote?: string;
  contactUpdate?: { customFields?: Record<string, unknown> };
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  // ====== Admin CRUD ======

  app.get(
    '/api/v1/custom-actions',
    { preHandler: app.requireAuth },
    async (req) => {
      const inboxIdParam =
        typeof req.query === 'object' && req.query !== null && 'inboxId' in req.query
          ? String((req.query as { inboxId?: unknown }).inboxId)
          : undefined;
      const isPrivileged = req.user.role === 'admin' || req.user.role === 'supervisor';

      // Agents only see actions scoped to inboxes they're members of (or global ones)
      let allowedInboxes: string[] | null = null;
      if (!isPrivileged) {
        allowedInboxes = await userInboxIds(app, req.user.sub, req.user.accountId);
      }

      const conditions = [];
      if (inboxIdParam) {
        // Filter by the requested inbox + global actions
        conditions.push(
          or(
            eq(schema.customActions.inboxId, inboxIdParam),
            isNull(schema.customActions.inboxId),
          )!,
        );
      }
      if (allowedInboxes) {
        // Restrict to allowed inboxes (or global)
        conditions.push(
          allowedInboxes.length > 0
            ? or(
                inArray(schema.customActions.inboxId, allowedInboxes),
                isNull(schema.customActions.inboxId),
              )!
            : isNull(schema.customActions.inboxId),
        );
      }

      conditions.push(eq(schema.customActions.accountId, req.user.accountId));
      const rows = await app.db
        .select()
        .from(schema.customActions)
        .where(sql`${sql.join(conditions, sql` AND `)}`);
      return { items: rows.map((r) => publicAction(r, { includeWebhookUrl: isPrivileged })) };
    },
  );

  app.get(
    '/api/v1/custom-actions/:id',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const [row] = await app.db
        .select()
        .from(schema.customActions)
        .where(and(eq(schema.customActions.id, id), eq(schema.customActions.accountId, req.user.accountId)))
        .limit(1);
      if (!row) return reply.notFound();
      return publicAction(row, { includeWebhookUrl: true });
    },
  );

  app.post(
    '/api/v1/custom-actions',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const body = createBody.parse(req.body);
      const url = isAllowedWebhookUrl(body.webhookUrl);
      if (!url.ok) return reply.badRequest(`webhookUrl: ${url.reason}`);

      // Validate inbox exists if scoped
      if (body.inboxId) {
        const [inbox] = await app.db
          .select({ id: schema.inboxes.id })
          .from(schema.inboxes)
          .where(eq(schema.inboxes.id, body.inboxId))
          .limit(1);
        if (!inbox) return reply.badRequest('inboxId não encontrado');
      }

      const secret = generateSecret();
      try {
        const [row] = await app.db
          .insert(schema.customActions)
          .values({
            name: body.name,
            label: body.label,
            icon: body.icon ?? null,
            color: body.color ?? null,
            formSchema: body.formSchema,
            webhookUrl: body.webhookUrl,
            secret: encryptJSON(secret),
            inboxId: body.inboxId ?? null,
            requiresRole: body.requiresRole,
            postNoteOnSuccess: body.postNoteOnSuccess,
            accountId: req.user.accountId,
          })
          .returning();
        app.log.info({ actionId: row!.id, actor: req.user.sub }, 'custom action created');
        void writeAudit(
          req,
          {
            action: 'custom_action.created',
            entityType: 'custom_action',
            entityId: row!.id,
            changes: {
              name: body.name,
              inboxId: body.inboxId,
              webhookOrigin: redactUrl(body.webhookUrl),
            },
          },
          { db: app.db, log: app.log },
        );
        return reply.code(201).send({ ...publicAction(row!), secret });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('action.name já existe');
        }
        throw err;
      }
    },
  );

  app.patch(
    '/api/v1/custom-actions/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = updateBody.parse(req.body);
      if (body.webhookUrl) {
        const url = isAllowedWebhookUrl(body.webhookUrl);
        if (!url.ok) return reply.badRequest(`webhookUrl: ${url.reason}`);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.label !== undefined) patch.label = body.label;
      if (body.icon !== undefined) patch.icon = body.icon ?? null;
      if (body.color !== undefined) patch.color = body.color ?? null;
      if (body.formSchema !== undefined) patch.formSchema = body.formSchema;
      if (body.webhookUrl !== undefined) patch.webhookUrl = body.webhookUrl;
      if (body.inboxId !== undefined) patch.inboxId = body.inboxId ?? null;
      if (body.requiresRole !== undefined) patch.requiresRole = body.requiresRole;
      if (body.postNoteOnSuccess !== undefined)
        patch.postNoteOnSuccess = body.postNoteOnSuccess;
      const [row] = await app.db
        .update(schema.customActions)
        .set(patch)
        .where(and(eq(schema.customActions.id, id), eq(schema.customActions.accountId, req.user.accountId)))
        .returning();
      if (!row) return reply.notFound();
      void writeAudit(
        req,
        {
          action: 'custom_action.updated',
          entityType: 'custom_action',
          entityId: row.id,
          changes: {
            fields: Object.keys(body),
            ...(body.webhookUrl ? { webhookOrigin: redactUrl(body.webhookUrl) } : {}),
          },
        },
        { db: app.db, log: app.log },
      );
      return publicAction(row);
    },
  );

  app.post(
    '/api/v1/custom-actions/:id/rotate-secret',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const secret = generateSecret();
      const [row] = await app.db
        .update(schema.customActions)
        .set({ secret: encryptJSON(secret), updatedAt: new Date() })
        .where(and(eq(schema.customActions.id, id), eq(schema.customActions.accountId, req.user.accountId)))
        .returning();
      if (!row) return reply.notFound();
      app.log.info({ actionId: id, actor: req.user.sub }, 'custom action: rotate secret');
      void writeAudit(
        req,
        { action: 'custom_action.secret_rotated', entityType: 'custom_action', entityId: id },
        { db: app.db, log: app.log },
      );
      return { ...publicAction(row), secret };
    },
  );

  app.delete(
    '/api/v1/custom-actions/:id',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const deleted = await app.db
        .delete(schema.customActions)
        .where(and(eq(schema.customActions.id, id), eq(schema.customActions.accountId, req.user.accountId)))
        .returning({ id: schema.customActions.id });
      if (deleted.length === 0) return reply.notFound();
      void writeAudit(
        req,
        { action: 'custom_action.deleted', entityType: 'custom_action', entityId: id },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );

  // ====== Run endpoint ======

  app.post(
    '/api/v1/custom-actions/:id/run',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const body = runBody.parse(req.body);

      const [action] = await app.db
        .select()
        .from(schema.customActions)
        .where(and(eq(schema.customActions.id, id), eq(schema.customActions.accountId, req.user.accountId)))
        .limit(1);
      if (!action || !action.enabled) return reply.notFound('action not found or disabled');

      // Role gate
      const order: Record<string, number> = { agent: 1, supervisor: 2, admin: 3 };
      if ((order[req.user.role] ?? 0) < (order[action.requiresRole] ?? 0)) {
        return reply.forbidden('insufficient role');
      }

      // Conversation-scoped: check access + inbox match
      let conv: typeof schema.conversations.$inferSelect | null = null;
      if (body.conversationId) {
        if (!(await canAccessConversation(app, req.user, body.conversationId))) {
          return reply.forbidden('no access to conversation');
        }
        const [c] = await app.db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, body.conversationId))
          .limit(1);
        if (!c) return reply.notFound('conversation not found');
        conv = c;
        if (action.inboxId && action.inboxId !== c.inboxId) {
          return reply.badRequest('action does not apply to this inbox');
        }
      }

      // Validate formData against formSchema using a dynamically built Zod schema.
      // Rejects unknown keys, enforces type, validates select.options, applies maxLength.
      const parsedSchema = formSchemaSchema.safeParse(action.formSchema);
      const fields = parsedSchema.success ? parsedSchema.data.fields : [];

      const shape: Record<string, z.ZodTypeAny> = {};
      for (const f of fields) {
        let s: z.ZodTypeAny;
        if (f.type === 'number') {
          s = z.coerce.number();
        } else if (f.type === 'select') {
          const allowed = (f.options ?? []).map((o) => o.value);
          s = allowed.length
            ? z.enum(allowed as [string, ...string[]])
            : z.string();
        } else {
          s = z.string().max(f.maxLength ?? 2000);
        }
        if (!f.required) s = s.optional();
        shape[f.key] = s;
      }
      const formParsed = z.object(shape).strict().safeParse(body.formData);
      if (!formParsed.success) {
        return reply.badRequest(formParsed.error.issues.map((i) => i.message).join('; '));
      }
      const cleanFormData = formParsed.data;

      // Idempotency: client may pass `Idempotency-Key`; if seen recently, return cached result.
      const idemHeader = req.headers['idempotency-key'];
      const idemKey =
        typeof idemHeader === 'string' && idemHeader.length > 0 && idemHeader.length <= 128
          ? idemHeader
          : null;
      const idemRedisKey = idemKey ? `action:run:idem:${id}:${idemKey}` : null;
      if (idemRedisKey) {
        const cached = await app.redis.get(idemRedisKey);
        if (cached) {
          try {
            return reply.code(200).send({ ...JSON.parse(cached), deduped: true });
          } catch {
            /* fall through */
          }
        }
      }

      // Decrypt secret
      let secret: string;
      try {
        secret = decryptJSON<string>(action.secret);
      } catch (err) {
        app.log.error({ err, actionId: id }, 'action.run: cannot decrypt secret');
        return reply.internalServerError();
      }

      const eventId = randomUUID();
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payload = {
        eventId,
        action: action.name,
        executedBy: { userId: req.user.sub, email: req.user.email, role: req.user.role },
        executedAt: new Date().toISOString(),
        contact: conv
          ? await loadContact(app, body.contactId ?? conv.contactId)
          : body.contactId
            ? await loadContact(app, body.contactId)
            : null,
        conversation: conv ? { id: conv.id, inboxId: conv.inboxId } : null,
        formData: cleanFormData,
      };

      const bodyStr = JSON.stringify(payload);
      // Sign timestamp + body (Stripe-style v1) — receiver should reject skew > 5min.
      const signedPayload = `${timestamp}.${bodyStr}`;
      const signature = `t=${timestamp},v1=${createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex')}`;

      const startedAt = Date.now();
      let response: RunResponse;
      let status: 'success' | 'error' = 'error';
      let errorMessage: string | undefined;
      try {
        const res = await safeFetch(action.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Blossom-Signature': signature,
            'X-Blossom-Timestamp': timestamp,
            'X-Blossom-Event-Id': eventId,
            'Idempotency-Key': eventId,
            'User-Agent': 'BlossomInbox/0.1 action-runner',
          },
          body: bodyStr,
          timeoutMs: 15_000,
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (!res.ok) {
          response = {
            status: 'error',
            message:
              typeof parsed === 'object' && parsed && 'message' in parsed
                ? String((parsed as { message: unknown }).message)
                : `HTTP ${res.status}`,
          };
          errorMessage = response.message;
        } else {
          // Coerce response shape — accept partial.
          const parsedObj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<
            string,
            unknown
          >;
          response = {
            status: parsedObj.status === 'error' ? 'error' : 'success',
            message: typeof parsedObj.message === 'string' ? parsedObj.message : undefined,
            privateNote:
              typeof parsedObj.privateNote === 'string' ? parsedObj.privateNote : undefined,
            contactUpdate:
              parsedObj.contactUpdate && typeof parsedObj.contactUpdate === 'object'
                ? (parsedObj.contactUpdate as RunResponse['contactUpdate'])
                : undefined,
          };
          status = response.status;
          if (response.status === 'error') errorMessage = response.message;
        }
      } catch (err) {
        const msg =
          err instanceof SafeFetchError ? `${err.reason}: ${err.message}` : (err as Error).message;
        response = { status: 'error', message: msg };
        errorMessage = msg;
        app.log.warn({ err, actionId: id }, 'action.run: webhook error');
      }
      const durationMs = Date.now() - startedAt;

      // Persist log (use cleaned formData, not raw body)
      await app.db.insert(schema.actionLogs).values({
        actionId: id,
        userId: req.user.sub,
        contactId: body.contactId ?? conv?.contactId ?? null,
        conversationId: body.conversationId ?? null,
        payload: { formData: cleanFormData, eventId },
        response: response as Record<string, unknown>,
        status,
        errorMessage: errorMessage ?? null,
        durationMs: String(durationMs),
      });

      // Side effects on success
      if (status === 'success' && conv) {
        if (action.postNoteOnSuccess && response.privateNote) {
          const [note] = await app.db
            .insert(schema.messages)
            .values({
              conversationId: conv.id,
              inboxId: conv.inboxId,
              senderType: 'system',
              content: `⚙️ ${action.label}: ${response.privateNote}`,
              isPrivateNote: true,
            })
            .returning();
          eventBus.emitEvent({
            type: 'message.created',
            inboxId: conv.inboxId,
            conversationId: conv.id,
            message: {
              id: note!.id,
              conversationId: note!.conversationId,
              inboxId: note!.inboxId,
              senderType: note!.senderType,
              senderId: note!.senderId,
              content: note!.content,
              contentType: note!.contentType,
              isPrivateNote: note!.isPrivateNote,
              createdAt: note!.createdAt,
            },
          });
        }
        if (response.contactUpdate?.customFields) {
          const contactId = body.contactId ?? conv.contactId;
          // Merge (non-destructive) — JSONB || preserves existing keys.
          const patch = response.contactUpdate.customFields;
          if (JSON.stringify(patch).length > 50_000) {
            app.log.warn({ actionId: id }, 'action: contactUpdate.customFields too large — skipping');
          } else {
            await app.db
              .update(schema.contacts)
              .set({
                customFields: sql`coalesce(${schema.contacts.customFields}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
                updatedAt: new Date(),
              })
              .where(eq(schema.contacts.id, contactId));
          }
        }
      }

      const result = { status, message: response.message, durationMs };
      // Cache for idempotency replay
      if (idemRedisKey) {
        await app.redis.set(idemRedisKey, JSON.stringify(result), 'EX', 3600);
      }
      void writeAudit(
        req,
        {
          action: 'custom_action.executed',
          entityType: 'custom_action',
          entityId: id,
          changes: { status, conversationId: body.conversationId, contactId: body.contactId },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(200).send(result);
    },
  );

  // ====== Logs ======
  app.get(
    '/api/v1/custom-actions/:id/logs',
    { preHandler: app.requireRole('admin', 'supervisor') },
    async (req) => {
      const { id } = idParams.parse(req.params);
      const rows = await app.db
        .select()
        .from(schema.actionLogs)
        .where(eq(schema.actionLogs.actionId, id))
        .orderBy(desc(schema.actionLogs.executedAt))
        .limit(50);
      return { items: rows };
    },
  );
}

async function loadContact(
  app: FastifyInstance,
  contactId: string,
): Promise<Record<string, unknown> | null> {
  const [c] = await app.db
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      customFields: schema.contacts.customFields,
    })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId))
    .limit(1);
  return c ?? null;
}

