import type { FastifyBaseLogger } from 'fastify';
import { schema, type DB } from '@blossom/db';
import { QUEUE_NAMES, type BotDispatchJob } from '../../queue';
import type { Queue } from 'bullmq';

export interface DispatchInput {
  conversationId: string;
  inboxId: string;
  contactId: string;
  newMessageId: string;
  botId: string;
  accountId: string;
}

interface DispatchDeps {
  db: DB;
  log: FastifyBaseLogger;
  /** Optional: when present, enqueues to BullMQ. When absent, falls back to in-process. */
  queue?: Queue<BotDispatchJob>;
}

/**
 * Public API: enqueue a bot dispatch. The actual delivery happens in the
 * BullMQ worker (`registerWorkers`), which calls `deliverBotWebhook`.
 *
 * The legacy in-process fallback is kept for tests and for scenarios where
 * the queue plugin isn't available — it is NOT recommended for production
 * since retries don't survive restarts.
 */
export function dispatchBot(input: DispatchInput, deps: DispatchDeps): void {
  if (deps.queue) {
    void deps.queue
      .add(
        'dispatch',
        input,
        {
          jobId: `${input.conversationId}__${input.newMessageId}`, // dedup (':' not allowed)
          // attempts/backoff inherited from queue defaults (4 attempts, exp backoff)
        },
      )
      .catch((err) => {
        deps.log.error({ err, input }, 'bot: failed to enqueue dispatch');
      });
    return;
  }
  // Fallback (no queue) — fire-and-forget direct delivery (used in tests).
  void import('./dispatcher-fn').then(({ deliverBotWebhook }) =>
    deliverBotWebhook(input, { db: deps.db, log: deps.log }).catch((err) =>
      deps.log.error({ err, input }, 'bot dispatch (direct) failed'),
    ),
  );
}

// Helper exported so callers in routes can resolve the queue from app instance:
export function getBotQueue(app: { queues: { getQueue: (n: string) => Queue }}): Queue<BotDispatchJob> {
  return app.queues.getQueue(QUEUE_NAMES.BOT_DISPATCH) as Queue<BotDispatchJob>;
}

// Touch unused symbol to avoid TS warning (keeps import for type narrowing future use).
void schema;
