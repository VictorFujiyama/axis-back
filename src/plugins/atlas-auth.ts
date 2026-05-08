import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config';

declare module 'fastify' {
  interface FastifyInstance {
    requireAtlasApiKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  app.decorate('requireAtlasApiKey', async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = config.ATLAS_API_KEY;
    if (!expected) {
      // Don't leak misconfiguration to the caller — same response as a bad key.
      return reply.unauthorized('Invalid or missing API key');
    }
    const header = req.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || provided !== expected) {
      return reply.unauthorized('Invalid or missing API key');
    }
  });
}

export default fp(plugin, { name: 'atlas-auth' });
