import type { FastifyInstance } from 'fastify';
import { type ModuleConfig, type ModuleManifest, toManifest } from '@blossom/sdk';
import { config } from '../../config';

const MODULE_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

const loaded: ModuleConfig[] = [];

export async function loadModules(app: FastifyInstance): Promise<ModuleConfig[]> {
  const keys = config.ENABLED_MODULES;
  if (keys.length === 0) {
    app.log.info('modules: none enabled (ENABLED_MODULES empty)');
    return [];
  }

  for (const key of keys) {
    if (!MODULE_KEY_RE.test(key)) {
      app.log.warn({ key }, 'modules: invalid key, skip');
      continue;
    }
    try {
      const specifier = `@blossom-modules/${key}`;
      const mod = (await import(specifier)) as { default?: ModuleConfig };
      const cfg = mod.default;
      if (!cfg || cfg.key !== key) {
        app.log.error(
          { key, got: cfg?.key },
          'modules: manifest key mismatch or missing default export',
        );
        continue;
      }
      if (loaded.some((m) => m.key === cfg.key)) {
        app.log.warn({ key }, 'modules: duplicate, skip');
        continue;
      }
      if (cfg.registerBackend) {
        // Encapsulate each module in its own scope so decorators/hooks don't
        // leak to the global app, and duplicate routes inside a module don't
        // crash boot for unrelated modules. No path prefix is imposed — modules
        // own their paths under /api/v1/modules/<key>/ by convention.
        const register = cfg.registerBackend;
        await app.register(async (scope) => {
          await register(scope, { log: scope.log.child({ module: cfg.key }) });
        });
      }
      loaded.push(cfg);
      app.log.info({ key: cfg.key, name: cfg.name }, 'modules: loaded');
    } catch (err) {
      app.log.error({ err, key }, 'modules: failed to load');
    }
  }
  return loaded;
}

export function listManifests(): ModuleManifest[] {
  return loaded.map(toManifest);
}
