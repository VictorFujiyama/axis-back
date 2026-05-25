import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eventBus } from '../../../realtime/event-bus';

// T-008b: POST /api/v1/contacts (create) and PATCH /api/v1/contacts/:id
// (update) must emit a `contact.created` event so the Atlas connector
// listener (T-006) can build + sign a `contact` envelope. The event is
// account-scoped (carries `accountId`) so the listener can drop non-source
// accounts before POSTing to Atlas (anti-leak P0). Tests stub `app.db` and
// spy on the eventBus singleton — the route imports the same module instance.

const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';
const CONTACT_ID = '99999999-8888-4777-8666-555555555555';

function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    name: 'João Silva',
    email: 'joao@example.com',
    phone: '+5511999999999',
    avatarUrl: null,
    customFields: {},
    blocked: false,
    accountId: TEST_ACCOUNT_ID,
    lastActivityAt: null,
    createdAt: new Date('2026-05-25T10:00:00.000Z'),
    updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

interface DbOptions {
  insertReturning?: unknown[];
  updateReturning?: unknown[];
}

async function buildTestApp(options: DbOptions = {}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const sensible = (await import('@fastify/sensible')).default;
  const { default: jwtPlugin } = await import('../../../plugins/jwt');
  const { contactRoutes } = await import('../routes');

  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(jwtPlugin);

  // POST goes through app.db.transaction(cb) → tx.insert().values().returning().
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(options.insertReturning ?? [contactRow()]),
      }),
    }),
  };
  // PATCH goes through app.db.update().set().where().returning().
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(options.updateReturning ?? [contactRow()]),
      }),
    }),
  });
  app.decorate('db', {
    transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    update,
  } as unknown as FastifyInstance['db']);

  await app.register(contactRoutes);
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance, role: 'admin' | 'supervisor' | 'agent'): string {
  const token = app.jwt.sign({
    sub: TEST_USER_ID,
    email: 'agent@example.com',
    role,
    accountId: TEST_ACCOUNT_ID,
  });
  return `Bearer ${token}`;
}

describe('contacts routes — contact.created emit (T-008b)', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emitEvent').mockImplementation(() => {});
  });

  afterEach(() => {
    emitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('POST /api/v1/contacts emits account-scoped contact.created on create', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/contacts',
        headers: { authorization: authHeader(app, 'agent') },
        payload: { name: 'João Silva', email: 'joao@example.com', phone: '+5511999999999' },
      });
      expect(res.statusCode).toBe(201);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith({
        type: 'contact.created',
        accountId: TEST_ACCOUNT_ID,
        contact: {
          id: CONTACT_ID,
          name: 'João Silva',
          email: 'joao@example.com',
          phone: '+5511999999999',
          createdAt: new Date('2026-05-25T10:00:00.000Z'),
        },
      });
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/v1/contacts/:id re-emits contact.created on update', async () => {
    const app = await buildTestApp({
      updateReturning: [contactRow({ name: 'João Updated' })],
    });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contacts/${CONTACT_ID}`,
        headers: { authorization: authHeader(app, 'admin') },
        payload: { name: 'João Updated' },
      });
      expect(res.statusCode).toBe(200);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      const emitted = emitSpy.mock.calls[0]![0] as {
        type: string;
        accountId: string;
        contact: { id: string; name: string | null };
      };
      expect(emitted.type).toBe('contact.created');
      expect(emitted.accountId).toBe(TEST_ACCOUNT_ID);
      expect(emitted.contact.id).toBe(CONTACT_ID);
      expect(emitted.contact.name).toBe('João Updated');
    } finally {
      await app.close();
    }
  });

  it('PATCH on a missing contact returns 404 and does NOT emit', async () => {
    const app = await buildTestApp({ updateReturning: [] });
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contacts/${CONTACT_ID}`,
        headers: { authorization: authHeader(app, 'admin') },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('PATCH without admin/supervisor role is forbidden and does NOT emit', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/contacts/${CONTACT_ID}`,
        headers: { authorization: authHeader(app, 'agent') },
        payload: { name: 'Nope' },
      });
      expect(res.statusCode).toBe(403);
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
