import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { equalizeTiming, hashPassword, verifyPassword } from './password';
import { writeAudit } from '../../lib/audit';
import {
  consumeRefreshToken,
  issueRefreshTokenWithUser,
  revokeRefreshToken,
  signAccessToken,
} from './tokens';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1),
});

const logoutBody = z.object({
  refreshToken: z.string().min(1),
});

const selectAccountBody = z.object({
  tempToken: z.string().min(1),
  accountId: z.string().uuid(),
});

const switchAccountBody = z.object({
  accountId: z.string().uuid(),
});

const atlasCheckEmailBody = z.object({
  email: z.string().email(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const body = loginBody.parse({
      ...(typeof req.body === 'object' && req.body ? req.body : {}),
      email: ((req.body as { email?: string })?.email ?? '').trim().toLowerCase(),
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(1);

    if (!user || user.deletedAt) {
      await equalizeTiming(body.password);
      void writeAudit(
        req,
        {
          action: 'auth.login_failed',
          entityType: 'user',
          changes: { email: body.email, reason: 'no_user' },
        },
        { db: app.db, log: app.log },
      );
      return reply.unauthorized('Invalid credentials');
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      void writeAudit(
        req,
        {
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          changes: { email: body.email, reason: 'bad_password' },
        },
        { db: app.db, log: app.log },
      );
      return reply.unauthorized('Invalid credentials');
    }
    void writeAudit(
      req,
      {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        actor: { id: user.id, email: user.email },
      },
      { db: app.db, log: app.log },
    );

    // Query accounts for this user
    const accountMemberships = await app.db
      .select({
        accountId: schema.accountUsers.accountId,
        role: schema.accountUsers.role,
        accountName: schema.accounts.name,
        availability: schema.accountUsers.availability,
        autoOffline: schema.accountUsers.autoOffline,
      })
      .from(schema.accountUsers)
      .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
      .where(eq(schema.accountUsers.userId, user.id));

    if (accountMemberships.length === 0) {
      return reply.forbidden('User has no account memberships');
    }

    if (accountMemberships.length === 1) {
      const membership = accountMemberships[0]!;
      const accessToken = signAccessToken(app, {
        sub: user.id,
        email: user.email,
        role: membership.role,
        accountId: membership.accountId,
      });
      const refreshToken = await issueRefreshTokenWithUser(app, user.id, membership.accountId);
      return reply.send({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: membership.role,
          avatarUrl: user.avatarUrl,
          accountId: membership.accountId,
          accountName: membership.accountName,
          accounts: accountMemberships.map((m) => ({
            id: m.accountId,
            name: m.accountName,
            role: m.role,
            availability: m.availability,
            auto_offline: m.autoOffline,
          })),
        },
      });
    }

    // Multiple accounts — require account selection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tempToken = (app.jwt.sign as any)(
      { sub: user.id, email: user.email, purpose: 'account-select' },
      { expiresIn: '5m' },
    );
    return reply.send({
      requiresAccountSelection: true,
      accounts: accountMemberships.map((m) => ({
        id: m.accountId,
        name: m.accountName,
        role: m.role,
      })),
      tempToken,
    });
  },
  );

  app.post('/api/v1/auth/select-account', async (req, reply) => {
    const body = selectAccountBody.parse(req.body);

    let decoded: { sub: string; email: string; purpose?: string };
    try {
      decoded = app.jwt.verify<{ sub: string; email: string; purpose?: string }>(body.tempToken);
    } catch {
      return reply.unauthorized('Invalid or expired token');
    }

    if (decoded.purpose !== 'account-select') {
      return reply.unauthorized('Invalid token purpose');
    }

    const userId = decoded.sub;

    const memberships = await app.db
      .select({
        accountId: schema.accountUsers.accountId,
        role: schema.accountUsers.role,
        accountName: schema.accounts.name,
        availability: schema.accountUsers.availability,
        autoOffline: schema.accountUsers.autoOffline,
      })
      .from(schema.accountUsers)
      .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
      .where(eq(schema.accountUsers.userId, userId));

    const membership = memberships.find((m) => m.accountId === body.accountId);
    if (!membership) {
      return reply.forbidden('User is not a member of this account');
    }

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user || user.deletedAt) {
      return reply.unauthorized('User no longer exists');
    }

    const accessToken = signAccessToken(app, {
      sub: user.id,
      email: user.email,
      role: membership.role,
      accountId: membership.accountId,
    });
    const refreshToken = await issueRefreshTokenWithUser(app, user.id, membership.accountId);

    return reply.send({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: membership.role,
        avatarUrl: user.avatarUrl,
        accountId: membership.accountId,
        accountName: membership.accountName,
        accounts: memberships.map((m) => ({
          id: m.accountId,
          name: m.accountName,
          role: m.role,
          availability: m.availability,
          auto_offline: m.autoOffline,
        })),
      },
    });
  });

  app.post(
    '/api/v1/auth/switch-account',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = switchAccountBody.parse(req.body);

      const memberships = await app.db
        .select({
          accountId: schema.accountUsers.accountId,
          role: schema.accountUsers.role,
          accountName: schema.accounts.name,
          availability: schema.accountUsers.availability,
          autoOffline: schema.accountUsers.autoOffline,
        })
        .from(schema.accountUsers)
        .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
        .where(eq(schema.accountUsers.userId, req.user.sub));

      const membership = memberships.find((m) => m.accountId === body.accountId);
      if (!membership) {
        return reply.forbidden('User is not a member of this account');
      }

      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, req.user.sub))
        .limit(1);

      if (!user || user.deletedAt) {
        return reply.unauthorized('User no longer exists');
      }

      const accessToken = signAccessToken(app, {
        sub: user.id,
        email: user.email,
        role: membership.role,
        accountId: membership.accountId,
      });
      const refreshToken = await issueRefreshTokenWithUser(app, user.id, membership.accountId);

      return reply.send({
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: membership.role,
          avatarUrl: user.avatarUrl,
          accountId: membership.accountId,
          accountName: membership.accountName,
          accounts: memberships.map((m) => ({
            id: m.accountId,
            name: m.accountName,
            role: m.role,
            availability: m.availability,
            auto_offline: m.autoOffline,
          })),
        },
      });
    },
  );

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const body = refreshBody.parse(req.body);
    const result = await consumeRefreshToken(app, body.refreshToken);
    if (!result) {
      return reply.unauthorized('Invalid refresh token');
    }
    const { userId, accountId } = result;
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user || user.deletedAt) {
      return reply.unauthorized('User no longer exists');
    }

    // Verify the account membership still exists
    const [membership] = await app.db
      .select({
        role: schema.accountUsers.role,
      })
      .from(schema.accountUsers)
      .where(
        and(
          eq(schema.accountUsers.userId, userId),
          eq(schema.accountUsers.accountId, accountId),
        ),
      )
      .limit(1);

    if (!membership) {
      return reply.forbidden('User is no longer a member of this account');
    }

    const accessToken = signAccessToken(app, {
      sub: user.id,
      email: user.email,
      role: membership.role,
      accountId,
    });
    const refreshToken = await issueRefreshTokenWithUser(app, user.id, accountId);
    return reply.send({ accessToken, refreshToken });
  });

  app.post(
    '/api/v1/auth/logout',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = logoutBody.parse(req.body);
      await revokeRefreshToken(app, body.refreshToken);
      void writeAudit(
        req,
        {
          action: 'auth.logout',
          entityType: 'user',
          entityId: req.user.sub,
          actor: { id: req.user.sub, email: req.user.email },
        },
        { db: app.db, log: app.log },
      );
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/auth/me',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, req.user.sub))
        .limit(1);
      if (!user || user.deletedAt) {
        return reply.notFound('User not found');
      }

      const memberships = await app.db
        .select({
          accountId: schema.accountUsers.accountId,
          role: schema.accountUsers.role,
          accountName: schema.accounts.name,
          availability: schema.accountUsers.availability,
          autoOffline: schema.accountUsers.autoOffline,
        })
        .from(schema.accountUsers)
        .innerJoin(schema.accounts, eq(schema.accountUsers.accountId, schema.accounts.id))
        .where(eq(schema.accountUsers.userId, user.id));

      const currentMembership = memberships.find((m) => m.accountId === req.user.accountId);

      return reply.send({
        id: user.id,
        email: user.email,
        name: user.name,
        role: currentMembership?.role ?? user.role,
        status: user.status,
        avatarUrl: user.avatarUrl,
        accountId: req.user.accountId,
        accountName: currentMembership?.accountName ?? '',
        accounts: memberships.map((m) => ({
          id: m.accountId,
          name: m.accountName,
          role: m.role,
          availability: m.availability,
          auto_offline: m.autoOffline,
        })),
      });
    },
  );

  // ---- Atlas integration (Phase 0 — account linking + SSO) ----
  // Called by atlas-company-os server-side, gated by X-API-Key.
  // Unversioned `/api/auth/*` keeps these outside the regular `/api/v1/*` surface.

  app.post(
    '/api/auth/check-email',
    { preHandler: app.requireAtlasApiKey },
    async (req, reply) => {
      const body = atlasCheckEmailBody.parse({
        email: ((req.body as { email?: string })?.email ?? '').trim().toLowerCase(),
      });
      const [user] = await app.db
        .select({ id: schema.users.id, deletedAt: schema.users.deletedAt })
        .from(schema.users)
        .where(eq(schema.users.email, body.email))
        .limit(1);
      const exists = Boolean(user && !user.deletedAt);
      return reply.send({ exists });
    },
  );
}

// Expose for seed script
export { hashPassword };
