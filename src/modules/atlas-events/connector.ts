import type { FastifyInstance } from 'fastify';
import { AtlasConnector, type ConnectorEvent } from '@atlas/connectors';
import { config } from '../../config';
import { QUEUE_NAMES } from '../../queue';
import { getConnection } from './connections';

/**
 * [Connect Flow / Phase 12.2] Per-account `AtlasConnector` (spec G3).
 *
 * One `AtlasConnector` per axis account: looks up the account's
 * `atlas_connections` row, builds an
 * `AtlasConnector` stamped with THAT connection's `org_id` + HMAC secret (the
 * Atlas base URL stays global — `config.ATLAS_URL`, spec §7), and caches it.
 * Returns `null` when the account has no connection — callers (T-05 emit) treat
 * that as the anti-leak rule: only accounts WITH a connection emit.
 *
 * Cache is keyed by `accountId` and additionally guarded on the connection's
 * `org_id` + `hmacSecret`, so a re-register that rotates the secret (T-07
 * upsert) transparently rebuilds the connector rather than emitting with a stale
 * HMAC. The `queueAdapter` mirrors the global connector: `.emit()` defers to the
 * shared `atlas-events` BullMQ queue (jobId = `event_id`), the worker calls
 * `.emitDirect()`.
 */
const accountConnectors = new Map<
  string,
  { connector: AtlasConnector; orgId: string; hmacSecret: string }
>();

export async function getConnectorForAccount(
  app: FastifyInstance,
  accountId: string,
): Promise<AtlasConnector | null> {
  const conn = await getConnection(app.db, accountId);
  if (!conn) return null;

  // The per-account path keeps only ATLAS_URL global; without it there is no
  // Atlas to point the connector at. The boot config marks it optional, so guard
  // loudly here rather than constructing a connector aimed at `undefined`.
  if (!config.ATLAS_URL) {
    throw new Error(
      'getConnectorForAccount: ATLAS_URL unset — the Atlas base URL stays global (spec §7) and is required to build a per-account connector.',
    );
  }

  const orgId = conn.atlasOrgId;
  const { hmacSecret } = conn.secrets;

  const cached = accountConnectors.get(accountId);
  if (cached && cached.orgId === orgId && cached.hmacSecret === hmacSecret) {
    return cached.connector;
  }

  const built = new AtlasConnector({
    atlasBaseUrl: config.ATLAS_URL,
    app: 'messaging',
    orgId,
    hmacSecret,
    queueAdapter: {
      enqueue: async (event: ConnectorEvent) => {
        await app.queues
          .getQueue<ConnectorEvent>(QUEUE_NAMES.ATLAS_EVENTS)
          .add(QUEUE_NAMES.ATLAS_EVENTS, event, { jobId: event.event_id });
      },
    },
  });
  accountConnectors.set(accountId, { connector: built, orgId, hmacSecret });
  return built;
}

/**
 * Drop cached per-account connector(s). Call after a re-register/deregister so
 * the next emit rebuilds against fresh connection state (T-07/T-08), and to
 * reset module state between tests. No arg clears every account.
 */
export function clearConnectorCache(accountId?: string): void {
  if (accountId) accountConnectors.delete(accountId);
  else accountConnectors.clear();
}
