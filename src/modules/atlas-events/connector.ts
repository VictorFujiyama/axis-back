import type { FastifyInstance } from 'fastify';
import { AtlasConnector, type ConnectorEvent } from '@atlas/connectors';
import { config } from '../../config';
import { QUEUE_NAMES } from '../../queue';

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
