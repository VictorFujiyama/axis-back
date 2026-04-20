import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { QUEUE_NAMES, type QueueName } from '../../queue';

const QUEUE_SCHEMA = z.enum([QUEUE_NAMES.BOT_DISPATCH, QUEUE_NAMES.EMAIL_OUTBOUND]);
const params = z.object({ name: QUEUE_SCHEMA });

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/queues',
    { preHandler: app.requireRole('admin') },
    async () => {
      const items = await Promise.all(
        Object.values(QUEUE_NAMES).map(async (name) => {
          const counts = await app.queues.getCounts(name as QueueName);
          return { name, counts };
        }),
      );
      return { items };
    },
  );

  app.post(
    '/api/v1/queues/:name/retry-failed',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { name } = params.parse(req.params);
      const count = await app.queues.retryFailed(name);
      return { retried: count };
    },
  );

  app.post(
    '/api/v1/queues/:name/drain',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { name } = params.parse(req.params);
      await app.queues.drainAll(name);
      return reply.code(204).send();
    },
  );
}
