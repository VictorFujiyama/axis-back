import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { QueueRegistry } from '../queue';

declare module 'fastify' {
  interface FastifyInstance {
    queues: QueueRegistry;
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const queues = new QueueRegistry();
  app.decorate('queues', queues);
  app.addHook('onClose', async () => {
    await queues.close();
  });
}

export default fp(plugin, { name: 'queue', dependencies: ['redis'] });
