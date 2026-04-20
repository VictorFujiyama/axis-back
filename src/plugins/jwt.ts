import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { UserRole } from '@blossom/shared-types';
import { config } from '../config';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: UserRole; accountId: string };
    user: { sub: string; email: string; role: UserRole; accountId: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function plugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, { secret: config.JWT_SECRET });

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.unauthorized('Invalid or missing token');
    }
  });

  app.decorate(
    'requireRole',
    (...roles: UserRole[]) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        try {
          await req.jwtVerify();
        } catch {
          return reply.unauthorized('Invalid or missing token');
        }
        if (!roles.includes(req.user.role)) {
          return reply.forbidden('Insufficient permissions');
        }
      },
  );
}

export default fp(plugin, { name: 'jwt' });
