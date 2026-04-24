import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { OnlineStatusTracker } from '../lib/online-status-tracker';

declare module 'fastify' {
  interface FastifyInstance {
    presence: OnlineStatusTracker;
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  const tracker = new OnlineStatusTracker(app.redis, app.db);
  app.decorate('presence', tracker);
}

export default fp(plugin, { name: 'presence', dependencies: ['redis', 'db'] });
