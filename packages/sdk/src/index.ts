import type { FastifyInstance, FastifyBaseLogger, FastifyRequest, FastifyReply } from 'fastify';

type UserRole = 'admin' | 'supervisor' | 'agent';

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface TabDeclaration {
  href: string;
  label: string;
  icon?: string;
}

export interface ModuleContext {
  log: FastifyBaseLogger;
}

export type BackendRegistrar = (
  app: FastifyInstance,
  ctx: ModuleContext,
) => void | Promise<void>;

export interface ModuleConfig {
  key: string;
  name: string;
  description?: string;
  tabs?: TabDeclaration[];
  registerBackend?: BackendRegistrar;
}

export function defineModule(config: ModuleConfig): ModuleConfig {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.key)) {
    throw new Error(
      `Invalid module key "${config.key}": use lowercase alphanumerics and hyphens`,
    );
  }
  return config;
}

export interface ModuleManifest {
  key: string;
  name: string;
  description?: string;
  tabs: TabDeclaration[];
}

export function toManifest(mod: ModuleConfig): ModuleManifest {
  return {
    key: mod.key,
    name: mod.name,
    description: mod.description,
    tabs: mod.tabs ?? [],
  };
}
