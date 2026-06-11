import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { QUEUE_NAMES } from '../index.js';
import { processGmailWatchRenew } from './gmail-watch-renew.js';

const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1×/dia

/**
 * Registra o worker do gmail-watch-renew + agenda o repeatable job.
 *
 * Só ativa quando `GMAIL_PUBSUB_TOPIC` está setado — sem push configurado,
 * watch nunca é registrado, então não há nada pra renovar.
 *
 * O job é idempotente do lado Google (re-watch da mesma conta + topic
 * apenas estende a expiração), então rodar 1×/dia é seguro mesmo que o
 * watch tenha sido renovado por um setup recente.
 */
export function registerGmailWatchRenewWorker(app: FastifyInstance): void {
  if (!config.GMAIL_PUBSUB_TOPIC) {
    app.log.info(
      'gmail-watch-renew: GMAIL_PUBSUB_TOPIC unset, worker dormant',
    );
    return;
  }

  app.queues.registerWorker(
    QUEUE_NAMES.GMAIL_WATCH_RENEW,
    async () => {
      await processGmailWatchRenew(app);
    },
    1,
  );

  // Agenda repeatable
  void app.queues
    .getQueue(QUEUE_NAMES.GMAIL_WATCH_RENEW)
    .add(
      'renew-tick',
      { tickIso: new Date().toISOString() },
      { repeat: { every: RENEW_INTERVAL_MS, key: 'gmail-watch-renew-tick' } },
    )
    .then(() => {
      app.log.info('gmail-watch-renew: repeatable scheduled (1d)');
    })
    .catch((err) => {
      app.log.warn(
        { err: (err as Error).message },
        'gmail-watch-renew: failed to schedule repeatable',
      );
    });
}
