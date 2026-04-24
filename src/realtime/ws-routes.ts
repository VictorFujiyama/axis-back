import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';
import { schema } from '@blossom/db';
import type { UserRole } from '@blossom/shared-types';
import { eventBus, type RealtimeEvent } from './event-bus';

/**
 * Reads the current users+contacts presence snapshot from Redis and broadcasts it
 * to every socket subscribed to account:{id}. Mirrors Chatwoot's
 * RoomChannel#broadcast_presence.
 */
export async function broadcastPresence(app: FastifyInstance, accountId: string): Promise<void> {
  try {
    const [users, contacts] = await Promise.all([
      app.presence.getAvailableUsers(accountId),
      app.presence.getAvailableContacts(accountId),
    ]);
    eventBus.emitEvent({ type: 'presence.update', accountId, users, contacts });
  } catch (err) {
    app.log.warn({ err, accountId }, 'broadcastPresence failed');
  }
}

interface SocketCtx {
  userId: string;
  userName: string;
  accountId: string;
  role: UserRole;
  inboxIds: Set<string>; // for agent ACL (snapshot — see review TODO)
  rooms: Set<string>;
  expiresAtMs: number;
  unsubscribe: () => void;
}

const ROOM_LIMIT = 200;
const SEND_BUFFER_LIMIT = 1_000_000; // 1 MB

const subscribeMsg = z.object({
  action: z.enum(['subscribe', 'unsubscribe']),
  rooms: z.array(z.string().min(1).max(80)).max(50),
});

const typingMsg = z.object({
  type: z.literal('typing'),
  conversationId: z.string().min(1).max(80),
});

function eventRoom(e: RealtimeEvent): string[] {
  // Each event maps to which rooms should receive it.
  switch (e.type) {
    case 'message.created':
      return [`conversation:${e.conversationId}`, `inbox:${e.inboxId}`];
    case 'conversation.created':
      return [`inbox:${e.inboxId}`];
    case 'conversation.updated':
    case 'conversation.assigned':
    case 'conversation.resolved':
    case 'conversation.reopened':
      return [`conversation:${e.conversationId}`, `inbox:${e.inboxId}`];
    case 'message.deleted':
    case 'message.updated':
      return [`conversation:${e.conversationId}`, `inbox:${e.inboxId}`];
    case 'typing.indicator':
      return [`conversation:${e.conversationId}`, `inbox:${e.inboxId}`];
    case 'presence.update':
      return [`account:${e.accountId}`];
  }
}

function canAccessInbox(ctx: SocketCtx, inboxId: string): boolean {
  if (ctx.role === 'admin' || ctx.role === 'supervisor') return true;
  return ctx.inboxIds.has(inboxId);
}

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {

  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Auth: JWT via Sec-WebSocket-Protocol (preferred) or ?token=... query.
    // Subprotocol avoids leaking token in proxy logs and Referer headers.
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const protoHeader = req.headers['sec-websocket-protocol'];
    const protoToken =
      typeof protoHeader === 'string'
        ? protoHeader.split(',').map((s) => s.trim()).find((s) => s.startsWith('jwt.'))?.slice(4)
        : undefined;
    const token = protoToken ?? url.searchParams.get('token');
    if (!token) {
      socket.close(4401, 'missing token');
      return;
    }
    let payload: {
      sub: string;
      email: string;
      role: UserRole;
      accountId?: string;
      aud?: string;
      exp?: number;
    };
    try {
      payload = app.jwt.verify(token);
    } catch {
      socket.close(4401, 'invalid token');
      return;
    }
    // Defense in depth: reject tokens minted for non-agent audiences (e.g. widget JWTs).
    if (payload.aud && payload.aud !== 'agent') {
      socket.close(4403, 'wrong audience');
      return;
    }
    if (!payload.sub || !payload.role || !payload.accountId) {
      socket.close(4401, 'missing claims');
      return;
    }
    const expiresAtMs = (payload.exp ?? 0) * 1000;

    // Load the user's name and inbox memberships once (snapshot — refreshed on reconnect).
    const [memberships, userRow] = await Promise.all([
      app.db
        .select({ inboxId: schema.inboxMembers.inboxId })
        .from(schema.inboxMembers)
        .where(eq(schema.inboxMembers.userId, payload.sub)),
      app.db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, payload.sub))
        .then((rows) => rows[0]),
    ]);

    const ctx: SocketCtx = {
      userId: payload.sub,
      userName: userRow?.name ?? payload.email,
      accountId: payload.accountId,
      role: payload.role,
      inboxIds: new Set(memberships.map((m) => m.inboxId)),
      // Auto-subscribe to the account room so presence.update broadcasts reach this socket.
      rooms: new Set([`user:${payload.sub}`, `account:${payload.accountId}`]),
      expiresAtMs,
      unsubscribe: () => {},
    };

    const send = (data: unknown): void => {
      // Slow-consumer guard: drop the connection rather than buffering unbounded.
      const ws = socket as unknown as { bufferedAmount?: number };
      if ((ws.bufferedAmount ?? 0) > SEND_BUFFER_LIMIT) {
        try {
          socket.close(1009, 'slow consumer');
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        socket.send(JSON.stringify(data));
      } catch (err) {
        app.log.warn({ err }, 'ws send failed');
      }
    };

    send({ type: 'hello', userId: ctx.userId, role: ctx.role });

    // Register presence heartbeat + kick off an initial presence broadcast so
    // every agent in this account sees the newcomer right away (Chatwoot does
    // the same on RoomChannel#subscribed).
    void app.presence
      .updatePresence(ctx.accountId, 'User', ctx.userId)
      .then(() => broadcastPresence(app, ctx.accountId))
      .catch((err: unknown) => app.log.warn({ err }, 'presence bootstrap failed'));

    // Subscribe to event bus and forward filtered events.
    // Defer with setImmediate so emit() returns to caller fast (HTTP latency).
    ctx.unsubscribe = eventBus.onEvent((event) => {
      // Typing indicators use room-level access only (no inbox ACL needed).
      if (event.type === 'typing.indicator') {
        // Don't echo back to the sender.
        if (event.userId === ctx.userId) return;
        const rooms = eventRoom(event);
        if (rooms.some((r) => ctx.rooms.has(r))) {
          setImmediate(() => send(event));
        }
        return;
      }
      // Presence is account-scoped; room ACL alone is enough since only
      // same-account sockets auto-subscribe to account:{id}.
      if (event.type === 'presence.update') {
        if (event.accountId !== ctx.accountId) return;
        setImmediate(() => send(event));
        return;
      }
      if (!canAccessInbox(ctx, event.inboxId)) return;
      const rooms = eventRoom(event);
      const matches = rooms.some((r) => ctx.rooms.has(r));
      if (!matches) return;
      setImmediate(() => send(event));
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: 'error', message: 'invalid json' });
        return;
      }

      // Handle typing indicator — broadcast to the conversation room (for
      // agents inside the thread) and the inbox room (so the sidebar list can
      // show a "digitando…" preview). Look up inboxId from the DB rather than
      // trusting the client — prevents a hostile client from fanning out
      // typing events to inboxes they shouldn't touch.
      const typingResult = typingMsg.safeParse(parsed);
      if (typingResult.success) {
        const { conversationId } = typingResult.data;
        void (async () => {
          const [row] = await app.db
            .select({ inboxId: schema.conversations.inboxId })
            .from(schema.conversations)
            .where(eq(schema.conversations.id, conversationId))
            .limit(1);
          if (!row || !canAccessInbox(ctx, row.inboxId)) return;
          eventBus.emitEvent({
            type: 'typing.indicator',
            inboxId: row.inboxId,
            conversationId,
            userId: ctx.userId,
            userName: ctx.userName,
          });
        })();
        return;
      }

      const result = subscribeMsg.safeParse(parsed);
      if (!result.success) {
        send({ type: 'error', message: 'invalid message format' });
        return;
      }
      const { action, rooms } = result.data;
      const accepted: string[] = [];
      for (const room of rooms) {
        // Validate room scope: agent can only join rooms within their inboxes.
        if (room.startsWith('inbox:')) {
          const inboxId = room.slice('inbox:'.length);
          if (!canAccessInbox(ctx, inboxId)) {
            send({ type: 'error', message: `forbidden: ${room}` });
            continue;
          }
        }
        if (action === 'subscribe') {
          if (ctx.rooms.size >= ROOM_LIMIT && !ctx.rooms.has(room)) {
            send({ type: 'error', message: 'room limit reached' });
            continue;
          }
          ctx.rooms.add(room);
          accepted.push(room);
        } else {
          ctx.rooms.delete(room);
          accepted.push(room);
        }
      }
      // ACK only the rooms touched in this request — avoids quadratic traffic.
      send({ type: action === 'subscribe' ? 'subscribed' : 'unsubscribed', rooms: accepted });
    });

    let pongAlive = true;
    socket.on('pong', () => {
      pongAlive = true;
    });

    // Liveness + token expiry check every 30s
    const ping = setInterval(() => {
      // Token expiration mid-session
      if (ctx.expiresAtMs && Date.now() >= ctx.expiresAtMs) {
        try {
          socket.close(4401, 'token expired');
        } catch {
          /* ignore */
        }
        return;
      }
      // Pong missed → terminate (NAT half-open)
      if (!pongAlive) {
        try {
          (socket as unknown as { terminate: () => void }).terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      pongAlive = false;
      try {
        socket.ping();
      } catch {
        clearInterval(ping);
      }
      // Refresh presence TTL in Redis (no broadcast on every ping — that would
      // be O(N²) traffic per account; we only broadcast on real state changes).
      void app.presence
        .updatePresence(ctx.accountId, 'User', ctx.userId)
        .catch((err: unknown) => app.log.warn({ err }, 'presence heartbeat failed'));
    }, 30_000);

    socket.on('close', () => {
      ctx.unsubscribe();
      clearInterval(ping);
      // Broadcast so other agents get a fresh snapshot. We do NOT remove the
      // user's presence score here — with multi-tab usage the other tabs' zadd
      // keeps them online. If this was the last tab, TTL evicts them in ~20s.
      void broadcastPresence(app, ctx.accountId).catch((err: unknown) =>
        app.log.warn({ err }, 'presence close broadcast failed'),
      );
    });
  });
}
