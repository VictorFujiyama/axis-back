import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@blossom/db';
import { config } from '../../config';
import {
  upsertConnection,
  deleteConnection,
  getConnectionByOrg,
  type ConnectionStatus,
} from '../atlas-events/connections';
import { clearConnectorCache } from '../atlas-events/connector';
import { runHandshake } from '../../scripts/atlas-handshake';

/**
 * [Connect Flow / Phase 12.2 — T-07] Server-to-server provisioning endpoint.
 *
 * `POST /atlas-connector/register` is how Atlas auto-provisions a connector when
 * an org owner connects their company (spec §"Duas ações" + the `register`
 * contract). Atlas, after creating its own connector + generating the HMAC /
 * MCP secrets, calls this with the org id, the linked axis user, the chosen axis
 * account (when the user belongs to >1), and the secrets. We:
 *   1. resolve which axis account the connection binds to (membership check —
 *      G1: links are per-user, connections per-account),
 *   2. `upsertConnection` (status `pending`, secrets encrypted at rest),
 *   3. run the handshake against Atlas (signs an empty body, flips Atlas's
 *      connector pending→active — reuses `runHandshake`, spec G7), and
 *   4. record the resulting status (`active` on success, `error` on failure).
 *
 * Auth is the same `X-API-Key == ATLAS_API_KEY` gate the Phase 0 `/api/auth/*`
 * routes use (`app.requireAtlasApiKey`). Idempotent (G8): re-registering the
 * same account overwrites org/secrets/status in place and re-runs the handshake,
 * so Atlas can safely retry. Provisioning is best-effort and decoupled from the
 * per-person SSO link — a handshake failure persists the connection as `error`
 * (still re-tryable) rather than throwing the whole request away.
 *
 * Always registered (control-plane): unlike the inbound/emit data-plane routes,
 * this is not gated by `ATLAS_CONNECTOR_ENABLED` — the `atlas_connections` table
 * is the source of truth for the per-account model, and gating the route that
 * CREATES connections behind the legacy global flag would be self-defeating.
 */

const registerBody = z.object({
  atlasOrgId: z.string().uuid(),
  axisUserId: z.string().uuid(),
  axisAccountId: z.string().uuid().optional(),
  hmacSecret: z.string().min(1),
  mcpBearer: z.string().min(1),
});

const deregisterBody = z.object({
  atlasOrgId: z.string().uuid(),
});

const userAccountsQuery = z.object({
  axisUserId: z.string().uuid(),
});

export async function atlasProvisionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/atlas-connector/register',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const parsed = registerBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid body' });
      }
      const { atlasOrgId, axisUserId, axisAccountId, hmacSecret, mcpBearer } = parsed.data;

      // G1: `atlas_user_links`/the verified axis user identifies a PERSON, but the
      // connector binds to an ACCOUNT. Resolve the account from the user's
      // memberships; validate the chosen account (multi-account) belongs to them.
      const memberships = await app.db
        .select({ accountId: schema.accountUsers.accountId })
        .from(schema.accountUsers)
        .where(eq(schema.accountUsers.userId, axisUserId));

      let accountId: string;
      if (axisAccountId) {
        const owns = memberships.some((m) => m.accountId === axisAccountId);
        if (!owns) {
          return reply
            .code(403)
            .send({ ok: false, error: 'user is not a member of the specified account' });
        }
        accountId = axisAccountId;
      } else if (memberships.length === 0) {
        return reply.code(403).send({ ok: false, error: 'user has no account memberships' });
      } else if (memberships.length === 1) {
        accountId = memberships[0]!.accountId;
      } else {
        // G6: the owner must pick which account the org links to; Atlas resolves
        // the choice (T-09 GET /user-accounts) and re-calls with axisAccountId.
        return reply
          .code(409)
          .send({ ok: false, error: 'user belongs to multiple accounts; axisAccountId required' });
      }

      const secrets = { hmacSecret, mcpBearer };

      // Persist `pending` BEFORE the handshake (spec/G8): the connection must
      // survive a mid-handshake crash so a retry is idempotent, and so emit can
      // already resolve the connector by account (emit checks existence, not
      // status). Drop the per-account connector cache so a rotated secret is
      // rebuilt rather than served stale (T-03 cache guard).
      await upsertConnection(app.db, { atlasAccountId: accountId, atlasOrgId, secrets, status: 'pending' });
      clearConnectorCache(accountId);

      // Handshake (G7): sign an empty body with this org's secret and POST to
      // Atlas so its connector flips pending→active. Needs the global Atlas base
      // URL (spec §7); without it we can't complete the handshake — leave the
      // connection `pending` for a later retry rather than reporting a false
      // `error`.
      let status: ConnectionStatus = 'pending';
      if (config.ATLAS_URL) {
        try {
          await runHandshake({ atlasUrl: config.ATLAS_URL, orgId: atlasOrgId, hmacSecret });
          status = 'active';
        } catch (err) {
          app.log.warn({ err, atlasOrgId }, '[atlas-connector/register] handshake failed');
          status = 'error';
        }
        await upsertConnection(app.db, { atlasAccountId: accountId, atlasOrgId, secrets, status });
        clearConnectorCache(accountId);
      } else {
        app.log.warn(
          { atlasOrgId },
          '[atlas-connector/register] ATLAS_URL unset — skipping handshake, connection left pending',
        );
      }

      return reply.send({ ok: true, status });
    },
  );

  /**
   * [Connect Flow / Phase 12.2 — T-08] Deregister: the inverse of register, the
   * server-to-server call Atlas makes when an org owner disconnects their company
   * (spec §"Desligar" + the `deregister` contract). Body carries only the org id;
   * we drop the `atlas_connections` row for that org, which immediately stops the
   * per-account emit (`getConnectorForAccount` lookups return null) and the
   * inbound/backfill verification (no connection → 401).
   *
   * Same `X-API-Key == ATLAS_API_KEY` gate as register. Idempotent (G8):
   * deregistering an org with no connection is a no-op that still answers
   * `{ ok: true }`, so Atlas can retry. The connector cache is keyed by axis
   * account, not org, so resolve the bound account first to drop its cached
   * connector; if there is no connection there is nothing to delete or clear.
   */
  app.post(
    '/atlas-connector/deregister',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const parsed = deregisterBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid body' });
      }
      const { atlasOrgId } = parsed.data;

      const existing = await getConnectionByOrg(app.db, atlasOrgId);
      await deleteConnection(app.db, { atlasOrgId });
      if (existing) clearConnectorCache(existing.atlasAccountId);

      return reply.send({ ok: true });
    },
  );

  /**
   * [Connect Flow / Phase 12.2 — T-09] `GET /atlas-connector/user-accounts?axisUserId=…`:
   * lists the axis accounts a linked user belongs to so Atlas can let the org
   * owner pick which one to bind (G6). Register answers 409 when the user has >1
   * account and no `axisAccountId` was given; Atlas resolves the ambiguity by
   * calling this, presenting the choice, then re-calling register with the
   * chosen account.
   *
   * Same `X-API-Key == ATLAS_API_KEY` gate as register/deregister. Joins
   * `account_users` (the membership + role) with `accounts` (the display name);
   * returns `{ ok: true, accounts: [{ accountId, name, role }] }`. A user with no
   * memberships yields an empty list (200), not an error — Atlas treats it as
   * "nothing to bind".
   */
  app.get(
    '/atlas-connector/user-accounts',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const parsed = userAccountsQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid query' });
      }
      const { axisUserId } = parsed.data;

      const accounts = await app.db
        .select({
          accountId: schema.accountUsers.accountId,
          name: schema.accounts.name,
          role: schema.accountUsers.role,
        })
        .from(schema.accountUsers)
        .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
        .where(eq(schema.accountUsers.userId, axisUserId));

      return reply.send({ ok: true, accounts });
    },
  );
}
