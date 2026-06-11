/**
 * Cron diário: re-chama `users.watch()` em todas inboxes Gmail ativas pra
 * evitar expiração (Gmail expira watch em ~7 dias).
 *
 * É idempotente do lado Google — re-chamar watch() na mesma conta + topic
 * só "renova" o tempo de expiração e devolve o mesmo historyId. Sem custo
 * extra.
 *
 * Roda como repeatable job no BullMQ. Cron registrado em
 * `src/queue/index.ts` quando GMAIL_PUBSUB_TOPIC está setado.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { setupGmailWatch } from '../../modules/channels/gmail-watch.js';

export async function processGmailWatchRenew(
  app: FastifyInstance,
): Promise<{ renewed: number; errors: number; skipped: number }> {
  const inboxes = await app.db
    .select()
    .from(schema.inboxes)
    .where(
      and(
        eq(schema.inboxes.channelType, 'email'),
        isNull(schema.inboxes.deletedAt),
      ),
    );

  let renewed = 0;
  let errors = 0;
  let skipped = 0;

  for (const inbox of inboxes) {
    const cfg = (inbox.config ?? {}) as {
      provider?: string;
      needsReauth?: boolean;
    };
    if (cfg.provider !== 'gmail' || cfg.needsReauth === true) {
      skipped++;
      continue;
    }

    try {
      await setupGmailWatch(app, inbox);
      renewed++;
    } catch (err) {
      errors++;
      app.log.warn(
        { inboxId: inbox.id, err: (err as Error).message },
        'gmail-watch-renew: failed pra esta inbox',
      );
    }
  }

  app.log.info(
    { renewed, errors, skipped, total: inboxes.length },
    'gmail-watch-renew: tick done',
  );

  return { renewed, errors, skipped };
}
