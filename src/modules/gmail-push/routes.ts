/**
 * Endpoint pra receber push notifications do Gmail via Cloud Pub/Sub.
 *
 * Quando uma inbox Gmail tem `users.watch({topicName})` ativo, o Gmail
 * publica uma notification no topic Pub/Sub a cada mudança no histórico
 * da conta (mensagem nova, lida, marcada etc.). O Pub/Sub assina o body
 * com um JWT OIDC e dispara push pra este endpoint.
 *
 * Fluxo:
 *  1. Valida JWT OIDC contra JWKS Google + audience configurada
 *  2. Decode envelope: `{ message: { data: <base64 json>, messageId } }`
 *  3. Parse data: `{ emailAddress, historyId }`
 *  4. Dedup via Redis SETNX `gmail-push:<messageId>` TTL 1h
 *  5. Lookup inbox por `config.gmailEmail = emailAddress`
 *  6. Enfileira gmail-sync immediato (alta prioridade)
 *  7. Responde 200 ack
 *
 * Gates:
 *  - Sem `GMAIL_PUBSUB_AUDIENCE` env, endpoint retorna 503 (push não
 *    configurado — polling fallback continua sendo o caminho).
 *  - Inbox not found ou deletada: 200 silent (Pub/Sub não re-entrega
 *    pra mesma config eternamente).
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { config } from '../../config.js';
import { OidcVerifyError, verifyGoogleOidc } from '../../lib/google-oidc-verify.js';
import { QUEUE_NAMES, type GmailSyncJob } from '../../queue/index.js';

const ENDPOINT_PATH = '/api/v1/webhooks/gmail-push';

/** Pub/Sub push envelope shape. */
const envelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

/** Payload Gmail dentro de `message.data` (base64-decoded JSON). */
const gmailPayloadSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.string(), z.number()]),
});

/** Derivar email da SA esperada a partir do project ID. Quando o usuário
 *  configura a push subscription, ele escolhe a SA — temos que saber qual.
 *  Convenção: `gmail-push@<GCP_PROJECT_ID>.iam.gserviceaccount.com`.
 *  Caller pode override via env GMAIL_PUSH_SA_EMAIL se mudou o nome. */
function expectedSaEmail(): string | null {
  const override = process.env['GMAIL_PUSH_SA_EMAIL'];
  if (override) return override;
  if (!config.GCP_PROJECT_ID) return null;
  return `gmail-push@${config.GCP_PROJECT_ID}.iam.gserviceaccount.com`;
}

export async function gmailPushRoutes(app: FastifyInstance): Promise<void> {
  app.post(ENDPOINT_PATH, async (req, reply) => {
    // Gate: sem audience configurada, endpoint dormente
    if (!config.GMAIL_PUBSUB_AUDIENCE) {
      app.log.warn(
        'gmail-push: hit but GMAIL_PUBSUB_AUDIENCE unset, returning 503',
      );
      return reply.serviceUnavailable('gmail-push not configured');
    }
    const sa = expectedSaEmail();
    if (!sa) {
      app.log.warn('gmail-push: no expected SA email (GCP_PROJECT_ID unset)');
      return reply.serviceUnavailable('gmail-push not configured');
    }

    // 1. Valida OIDC JWT do Pub/Sub
    try {
      await verifyGoogleOidc(req.headers.authorization, {
        audience: config.GMAIL_PUBSUB_AUDIENCE,
        expectedEmail: sa,
      });
    } catch (err) {
      if (err instanceof OidcVerifyError) {
        app.log.warn({ code: err.code, msg: err.message }, 'gmail-push: JWT reject');
        return reply.unauthorized(err.code);
      }
      throw err;
    }

    // 2. Decode envelope
    const env = envelopeSchema.safeParse(req.body);
    if (!env.success) {
      app.log.warn({ issues: env.error.issues }, 'gmail-push: bad envelope');
      // 200 silent: malformed envelope é bug do publisher, re-entrega não ajuda.
      return reply.code(200).send({ ok: false, reason: 'bad-envelope' });
    }
    const { message } = env.data;
    const messageId = message.messageId;

    // 3. Decode data (base64 JSON Gmail payload)
    let payload: z.infer<typeof gmailPayloadSchema>;
    try {
      const decoded = Buffer.from(message.data, 'base64').toString('utf8');
      payload = gmailPayloadSchema.parse(JSON.parse(decoded));
    } catch (err) {
      app.log.warn(
        { messageId, err: (err as Error).message },
        'gmail-push: bad payload',
      );
      return reply.code(200).send({ ok: false, reason: 'bad-payload' });
    }

    // 4. Idempotency via Redis SETNX
    const dedupKey = `gmail-push:${messageId}`;
    const acquired = await app.redis.set(dedupKey, '1', 'EX', 3600, 'NX');
    if (acquired !== 'OK') {
      app.log.info(
        { messageId, emailAddress: payload.emailAddress },
        'gmail-push: duplicate, skip',
      );
      return reply.code(200).send({ ok: true, dedup: true });
    }

    // 5. Lookup inbox pelo gmailEmail
    const inboxes = await app.db
      .select({
        id: schema.inboxes.id,
        config: schema.inboxes.config,
      })
      .from(schema.inboxes)
      .where(
        and(
          eq(schema.inboxes.channelType, 'email'),
          isNull(schema.inboxes.deletedAt),
        ),
      );
    const inbox = inboxes.find((i) => {
      const cfg = (i.config ?? {}) as { provider?: string; gmailEmail?: string };
      return cfg.provider === 'gmail' && cfg.gmailEmail === payload.emailAddress;
    });

    if (!inbox) {
      app.log.warn(
        { emailAddress: payload.emailAddress, messageId },
        'gmail-push: no inbox matches email — ignoring',
      );
      // 200 silent: inbox foi deletada após watch() ativo. Acabar o
      // re-delivery loop. (Cleanup: cron poderia chamar `users.stop()`
      // mas isso requer um access_token vivo que talvez não temos mais.)
      return reply.code(200).send({ ok: true, ignored: 'no-inbox' });
    }

    // 6. Enfileira gmail-sync imediato (prioridade alta)
    await app.queues
      .getQueue<GmailSyncJob>(QUEUE_NAMES.GMAIL_SYNC)
      .add(
        'push-triggered',
        { inboxId: inbox.id },
        {
          priority: 1, // mais alto que polling repeatable
          removeOnComplete: { age: 3600, count: 100 },
          removeOnFail: { age: 24 * 3600 },
        },
      );

    app.log.info(
      {
        inboxId: inbox.id,
        emailAddress: payload.emailAddress,
        historyId: payload.historyId,
        messageId,
      },
      'gmail-push: enqueued sync',
    );
    return reply.code(200).send({ ok: true, enqueued: true });
  });
}
