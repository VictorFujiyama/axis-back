// Re-declares the host platform's Fastify augmentations so this module can
// type-check standalone. Runtime values come from axis-back plugins (jwt, db,
// sensible) when the module is registered inside the host app.

import 'fastify';
import '@fastify/jwt';
import type { DB } from '@blossom/db';
import type { UserRole } from '@blossom/shared-types';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: UserRole; accountId: string };
    user: { sub: string; email: string; role: UserRole; accountId: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    requireAuth: (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
  interface FastifyReply {
    notFound: (msg?: string) => FastifyReply;
    badRequest: (msg?: string) => FastifyReply;
    unauthorized: (msg?: string) => FastifyReply;
    forbidden: (msg?: string) => FastifyReply;
    conflict: (msg?: string) => FastifyReply;
  }
}
