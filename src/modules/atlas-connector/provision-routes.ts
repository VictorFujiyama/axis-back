import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@blossom/db';
import { config } from '../../config';
import {
  upsertConnection,
  deleteConnection,
  getConnectionByOrg,
  type ConnectionStatus,
} from '../atlas-events/connections';
import { clearConnectorCache } from '../atlas-events/connector';
import { hashPassword } from '../auth/password';
import { runHandshake } from '../../scripts/atlas-handshake';
import { backfillAssignedBotIdOnBotChange } from '../inboxes/backfill';

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
 * Always registered (control-plane): unlike the inbound/emit data-plane routes
 * (gated by `ATLAS_URL`), this is never gated — the `atlas_connections` table is
 * the source of truth for the per-account model, and gating the route that
 * CREATES connections behind the connector switch would be self-defeating.
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

const ensureBotLinkBody = z.object({
  atlasOrgId: z.string().uuid(),
});

const setInboxDefaultBotBody = z.object({
  atlasOrgId: z.string().uuid(),
  inboxId: z.string().uuid(),
  enabled: z.boolean(),
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
   * [axis-connect-autonomy / T-00a — D14] `POST /atlas-connector/ensure-bot-link`:
   * idempotently provision the synthetic "Atlas bot" identity an org's
   * qualifier-agent acts under when it runs in autonomous (L3) mode.
   *
   * The MCP write tools (`messaging.send_message`/`messaging.tag`) gate every
   * mutation through `atlas_user_links` (tools.ts `assertAtlasUserMapped`): a row
   * keyed `(accountId, atlasOrgId, atlasAppUserId)` must exist or the call is
   * `forbidden`. Human users get that row from the iframe SSO exchange, but the
   * agent has no human session — so Atlas calls this right after `/register` to
   * mint a bot user (`atlas_app_user_id = 'atlas-bot:<orgId>'`) and link it. The
   * worker then enters `withAmbient({ userId: 'atlas-bot:<orgId>' })` (T-00c) and
   * its MCP headers resolve.
   *
   * Same `X-API-Key == ATLAS_API_KEY` gate as register/deregister. Idempotent:
   * an existing bot link short-circuits and returns its axis user. The account is
   * resolved from the connection `/register` already created (`getConnectionByOrg`);
   * if there is no connection yet we answer 409 — Atlas registers first, then
   * ensures the bot link (best-effort, re-tryable). The user + membership + link
   * are written in one transaction so a partial bot identity never persists.
   */
  app.post(
    '/atlas-connector/ensure-bot-link',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const parsed = ensureBotLinkBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid body' });
      }
      const { atlasOrgId } = parsed.data;

      // The bot binds to the same axis account the org's connector binds to.
      // No connection → register hasn't run yet; nothing to bind the bot to.
      const connection = await getConnectionByOrg(app.db, atlasOrgId);
      if (!connection) {
        return reply
          .code(409)
          .send({ ok: false, error: 'no connection for org; register first' });
      }
      const accountId = connection.atlasAccountId;
      const botAppUserId = `atlas-bot:${atlasOrgId}`;

      // Idempotent: the bot link already exists → return its axis user, no writes.
      const [existing] = await app.db
        .select({ axisUserId: schema.atlasUserLinks.axisUserId })
        .from(schema.atlasUserLinks)
        .where(
          and(
            eq(schema.atlasUserLinks.accountId, accountId),
            eq(schema.atlasUserLinks.atlasOrgId, atlasOrgId),
            eq(schema.atlasUserLinks.atlasAppUserId, botAppUserId),
          ),
        )
        .limit(1);
      if (existing) {
        return reply.send({ ok: true, axisUserId: existing.axisUserId });
      }

      // Mint the bot user (flagged `is_atlas_bot`), add it to the account, and
      // record the link — all-or-nothing so a half-built identity never leaks.
      // The password is random throwaway: the bot never authenticates as a human.
      const botEmail = `bot+${atlasOrgId}@atlas-system.local`;
      const passwordHash = await hashPassword(randomBytes(32).toString('hex'));
      const axisUserId = await app.db.transaction(async (tx) => {
        // Re-use the bot user if it survived a prior disconnect (which drops the
        // link but may leave the user) — `users.email` is unique.
        let [user] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, botEmail))
          .limit(1);
        if (!user) {
          [user] = await tx
            .insert(schema.users)
            .values({
              email: botEmail,
              name: `Atlas Bot — ${atlasOrgId}`,
              passwordHash,
              isAtlasBot: true,
            })
            .returning({ id: schema.users.id });
        }
        await tx
          .insert(schema.accountUsers)
          .values({ accountId, userId: user!.id })
          .onConflictDoNothing();
        await tx
          .insert(schema.atlasUserLinks)
          .values({ accountId, axisUserId: user!.id, atlasAppUserId: botAppUserId, atlasOrgId })
          .onConflictDoNothing();
        return user!.id;
      });

      return reply.send({ ok: true, axisUserId });
    },
  );

  /**
   * [axis-connect-autonomy / Fase G — T-19', D27/D30/Gap 3] `POST
   * /atlas-connector/set-inbox-default-bot`: turn the Atlas qualifier-agent on
   * (or off) for one inbox by pointing `inbox.defaultBotId` at a `bots` row.
   *
   * Smart-handoff (D27) reuses axis's existing bot-assignment infra: a new
   * conversation in an inbox with a `defaultBotId` is born `assignedBotId=<that
   * bot>`, `status='pending'` — invisible to humans until the bot hands off
   * (`channels/helpers.ts`). So "Atlas manages this inbox" == "the inbox's
   * default bot IS the Atlas bot".
   *
   * Gap 3 (LESSONS) is why the default bot is a real `bots` row, NOT the synthetic
   * `atlas-bot:<orgId>` user from `ensure-bot-link`: `conversations.assigned_bot_id`
   * has an ENFORCED FK → `bots(id)`, and `channels/helpers.ts` copies
   * `inbox.defaultBotId` straight into `conversations.assigned_bot_id` on create.
   * Pointing `defaultBotId` at a `users.id` would pass here (the column has no FK)
   * but FK-violate on the next inbound message, bricking the inbox. So on enable we
   * get-or-create a `(accountId, inboxId)` builtin bot ('Atlas Assistant') and use
   * its id. The MCP write identity (`atlas_user_links`/`users.id`, T-00a) is a
   * separate concern and stays as-is.
   *
   * Same `X-API-Key == ATLAS_API_KEY` gate as register/deregister. The account is
   * resolved from the org's connection (`getConnectionByOrg`); 409 with no
   * connection. The inbox must belong to that account (404 unknown, 403
   * cross-account — D32 defense-in-depth). Idempotent: a no-op enable/disable
   * answers `{ ok: true, unchanged: true }` without re-pointing the inbox. On
   * disable the `bots` row is left in place so a later re-enable reuses it.
   */
  app.post(
    '/atlas-connector/set-inbox-default-bot',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const parsed = setInboxDefaultBotBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid body' });
      }
      const { atlasOrgId, inboxId, enabled } = parsed.data;

      // The inbox must live under the account the org's connector binds to.
      const connection = await getConnectionByOrg(app.db, atlasOrgId);
      if (!connection) {
        return reply.code(409).send({ ok: false, error: 'no connection for org; register first' });
      }
      const accountId = connection.atlasAccountId;

      const [inbox] = await app.db
        .select({ id: schema.inboxes.id, accountId: schema.inboxes.accountId, defaultBotId: schema.inboxes.defaultBotId })
        .from(schema.inboxes)
        .where(eq(schema.inboxes.id, inboxId))
        .limit(1);
      if (!inbox) {
        return reply.code(404).send({ ok: false, error: 'inbox not found' });
      }
      // D32: never trust the body's org alone — the inbox must be the bound account's.
      if (inbox.accountId !== accountId) {
        return reply.code(403).send({ ok: false, error: 'inbox belongs to a different account' });
      }

      if (!enabled) {
        // Disable: clear the pointer; leave the bots row for a future re-enable.
        if (inbox.defaultBotId === null) {
          return reply.send({ ok: true, inboxId, defaultBotId: null, botsRowId: null, unchanged: true });
        }
        await app.db
          .update(schema.inboxes)
          .set({ defaultBotId: null, updatedAt: new Date() })
          .where(eq(schema.inboxes.id, inboxId));
        return reply.send({ ok: true, inboxId, defaultBotId: null, botsRowId: null, unchanged: false });
      }

      // Enable: get-or-create the Atlas `bots` row for this (account, inbox). The
      // secret is a random throwaway — a builtin bot never calls an external
      // webhook, but the column is notNull.
      const [existingBot] = await app.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(and(eq(schema.bots.accountId, accountId), eq(schema.bots.inboxId, inboxId)))
        .limit(1);

      let botsRowId: string;
      if (existingBot) {
        botsRowId = existingBot.id;
      } else {
        const [created] = await app.db
          .insert(schema.bots)
          .values({
            accountId,
            inboxId,
            name: 'Atlas Assistant',
            botType: 'builtin',
            secret: randomBytes(32).toString('hex'),
            enabled: true,
          })
          .returning({ id: schema.bots.id });
        botsRowId = created!.id;
      }

      // Idempotent: already pointing at this bot → no write.
      if (inbox.defaultBotId === botsRowId) {
        return reply.send({ ok: true, inboxId, defaultBotId: botsRowId, botsRowId, unchanged: true });
      }
      await app.db
        .update(schema.inboxes)
        .set({ defaultBotId: botsRowId, updatedAt: new Date() })
        .where(eq(schema.inboxes.id, inboxId));
      // Bug #A2 backfill — after switching the inbox's default bot, adopt any
      // open/pending/snoozed threads that had no bot attached. Mirrors the
      // twin in `inboxes/routes.ts` PATCH; see `backfill.ts` for contract.
      // Wrapped: backfill is a side effect on top of a successful default_bot
      // change. If it fails, we log and still succeed the endpoint (the
      // primary write already committed).
      try {
        const adopted = await backfillAssignedBotIdOnBotChange(app.db, inboxId, botsRowId);
        if (adopted > 0) {
          app.log.info(
            { inboxId, botId: botsRowId, adopted },
            'atlas-connector: backfilled assigned_bot_id on open threads after default_bot_id change',
          );
        }
      } catch (err) {
        app.log.warn({ err, inboxId, botId: botsRowId }, 'atlas-connector: assigned_bot_id backfill failed (non-fatal)');
      }
      return reply.send({ ok: true, inboxId, defaultBotId: botsRowId, botsRowId, unchanged: false });
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
