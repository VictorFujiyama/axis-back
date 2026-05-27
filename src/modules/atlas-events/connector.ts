import type { FastifyInstance } from 'fastify';
import { AtlasConnector, type ConnectorEvent } from '@atlas/connectors';
import { config } from '../../config';
import { QUEUE_NAMES } from '../../queue';
import { getConnection } from './connections';

/**
 * [12.2.10] Process-singleton `AtlasConnector` for the messaging connector.
 *
 * Gated on `ATLAS_CONNECTOR_ENABLED`: returns `null` when the Phase 12.2 path
 * is off so callers (enqueue listeners in T-006, the worker in T-007) skip the
 * SDK client entirely and fall through to the legacy Phase B leg.
 *
 * The `queueAdapter` defers `.emit()` to the existing BullMQ `atlas-events`
 * queue rather than POSTing inline: the listener side enqueues a job (jobId =
 * `event_id` for idempotency, L-603), and the worker side dequeues and calls
 * `.emitDirect()` for the actual sign + POST + retry. One connector serves both
 * paths in-process — `emitDirect` bypasses the adapter, so the worker reuses
 * this same instance.
 */
let connector: AtlasConnector | null = null;

export function getAtlasConnector(app: FastifyInstance): AtlasConnector | null {
  if (!config.ATLAS_CONNECTOR_ENABLED) return null;
  if (connector) return connector;

  const { ATLAS_URL, ATLAS_ORG_ID, ATLAS_HMAC_SECRET } = config;
  // The boot precheck in config.ts throws when ATLAS_CONNECTOR_ENABLED=true with
  // any of these unset, so reaching here with a hole is an unreachable invariant.
  // Assert loudly rather than silently disabling the connector.
  if (!ATLAS_URL || !ATLAS_ORG_ID || !ATLAS_HMAC_SECRET) {
    throw new Error(
      'getAtlasConnector: ATLAS_CONNECTOR_ENABLED=true but ATLAS_URL/ATLAS_ORG_ID/ATLAS_HMAC_SECRET unset (boot precheck should have caught this).',
    );
  }

  connector = new AtlasConnector({
    atlasBaseUrl: ATLAS_URL,
    app: 'messaging',
    orgId: ATLAS_ORG_ID,
    hmacSecret: ATLAS_HMAC_SECRET,
    queueAdapter: {
      enqueue: async (event: ConnectorEvent) => {
        await app.queues
          .getQueue<ConnectorEvent>(QUEUE_NAMES.ATLAS_EVENTS)
          .add(QUEUE_NAMES.ATLAS_EVENTS, event, { jobId: event.event_id });
      },
    },
  });
  return connector;
}

/**
 * [Connect Flow / Phase 12.2] Per-account `AtlasConnector` (spec G3).
 *
 * Replaces the global `getAtlasConnector` singleton with one connector PER axis
 * account: looks up the account's `atlas_connections` row, builds an
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
