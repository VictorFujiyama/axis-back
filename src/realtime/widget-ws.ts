import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { webchatConfig } from '../modules/channels/webchat-config';
import { eventBus, type RealtimeEvent } from './event-bus';

type WidgetAvailability = 'online' | 'away';

// Team is "online" when at least one of the inbox's members is available
// (chosen status 'online'). Inboxes with no explicit members fall back to any
// available account user so the widget doesn't read as permanently away.
function availabilityFrom(
  users: Record<string, 'online' | 'busy' | 'offline'>,
  memberIds: Set<string>,
): WidgetAvailability {
  const online = Object.keys(users).filter((id) => users[id] === 'online');
  const relevant = memberIds.size > 0 ? online.filter((id) => memberIds.has(id)) : online;
  return relevant.length > 0 ? 'online' : 'away';
}

const widgetTypingMsg = z.object({
  type: z.literal('typing'),
  conversationId: z.string().uuid(),
});

interface WidgetCtx {
  inboxId: string;
  contactId: string;
  visitorId: string;
  expiresAtMs: number;
  unsubscribe: () => void;
}

export async function widgetWsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/widget', { websocket: true }, async (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    // Token via subprotocol or query
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
    let payload: { aud?: string; inboxId: string; contactId: string; visitorId: string; exp?: number };
    try {
      payload = app.jwt.verify(token);
    } catch {
      socket.close(4401, 'invalid token');
      return;
    }
    if (payload.aud !== 'widget') {
      socket.close(4403, 'wrong audience');
      return;
    }

    const ctx: WidgetCtx = {
      inboxId: payload.inboxId,
      contactId: payload.contactId,
      visitorId: payload.visitorId,
      expiresAtMs: (payload.exp ?? 0) * 1000,
      unsubscribe: () => {},
    };

    const send = (data: unknown): void => {
      const ws = socket as unknown as { bufferedAmount?: number };
      if ((ws.bufferedAmount ?? 0) > 1_000_000) {
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
        app.log.warn({ err }, 'widget ws send failed');
      }
    };

    // Find ALL conversations for this contact in this inbox (multi-tab support).
    const initialConvs = await app.db
      .select({ id: schema.conversations.id, status: schema.conversations.status })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.contactId, ctx.contactId),
          eq(schema.conversations.inboxId, ctx.inboxId),
        ),
      )
      .orderBy(desc(schema.conversations.updatedAt));

    // Set of conversation IDs the visitor "owns" — declared BEFORE listeners (no TDZ).
    const knownConvIds = new Set<string>(initialConvs.map((c) => c.id));
    const latestConv = initialConvs[0];

    // Display name for typing events. Anonymous widget visitors fall back to
    // "Visitante" so agents still get a meaningful "X está digitando…" label.
    const [contactRow] = await app.db
      .select({ name: schema.contacts.name })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, ctx.contactId))
      .limit(1);
    const contactName =
      contactRow?.name && contactRow.name.trim().length > 0
        ? contactRow.name
        : 'Visitante';

    // Team availability (D7). Resolve the inbox's account + members once, then
    // recompute on every presence.update for that account.
    const [inboxRow] = await app.db
      .select({ accountId: schema.inboxes.accountId, config: schema.inboxes.config })
      .from(schema.inboxes)
      .where(eq(schema.inboxes.id, ctx.inboxId))
      .limit(1);
    const showStatus = webchatConfig(inboxRow?.config).availability.showStatus;
    const accountId = inboxRow?.accountId ?? null;
    let memberIds = new Set<string>();
    let availability: WidgetAvailability = 'away';
    if (showStatus && accountId) {
      const [memberRows, users] = await Promise.all([
        app.db
          .select({ userId: schema.inboxMembers.userId })
          .from(schema.inboxMembers)
          .where(eq(schema.inboxMembers.inboxId, ctx.inboxId)),
        app.presence.getAvailableUsers(accountId),
      ]);
      memberIds = new Set(memberRows.map((r) => r.userId));
      availability = availabilityFrom(users, memberIds);
    }

    send({
      type: 'hello',
      contactId: ctx.contactId,
      conversationId: latestConv?.id ?? null,
      conversationStatus: latestConv?.status ?? null,
      ...(showStatus ? { availability } : {}),
    });

    // Single listener: learns new convs from visitor's own messages AND forwards replies.
    ctx.unsubscribe = eventBus.onEvent((event: RealtimeEvent) => {
      // Presence drives the widget's team-availability badge (D7); the raw
      // agent/contact rosters never reach the socket — only the derived state.
      if (event.type === 'presence.update') {
        if (!showStatus || !accountId || event.accountId !== accountId) return;
        const next = availabilityFrom(event.users, memberIds);
        if (next !== availability) {
          availability = next;
          setImmediate(() => send({ type: 'availability.update', availability: next }));
        }
        return;
      }
      // contact.created is account-scoped (no inboxId) and agent/atlas-only —
      // never forward CRM contact records to widget visitors.
      if (event.type === 'contact.created') return;
      if (event.inboxId !== ctx.inboxId) return;

      if (event.type === 'message.created') {
        // Echo from the visitor → register the conv (covers brand-new conversations).
        if (
          event.message.senderType === 'contact' &&
          event.message.senderId === ctx.contactId
        ) {
          knownConvIds.add(event.conversationId);
          return; // don't echo back to the visitor
        }
        // Forward only replies in conversations the visitor owns; skip private notes.
        if (event.message.isPrivateNote) return;
        if (!knownConvIds.has(event.conversationId)) return;
        setImmediate(() => send(event));
      } else if (
        event.type === 'conversation.assigned' ||
        event.type === 'conversation.resolved' ||
        event.type === 'conversation.reopened'
      ) {
        if (!knownConvIds.has(event.conversationId)) return;
        setImmediate(() => send(event));
      }
    });

    // The only accepted inbound message is a typing indicator — any other
    // payload closes the socket (anti-abuse). Validate conversationId is one
    // the visitor owns so a hostile widget token can't fan out typing events
    // into conversations that don't belong to it.
    socket.on('message', (raw: { toString: () => string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        try { socket.close(1003, 'invalid'); } catch { /* ignore */ }
        return;
      }
      const typingResult = widgetTypingMsg.safeParse(parsed);
      if (typingResult.success) {
        const { conversationId } = typingResult.data;
        if (!knownConvIds.has(conversationId)) return;
        eventBus.emitEvent({
          type: 'typing.indicator',
          inboxId: ctx.inboxId,
          conversationId,
          // contactId doubles as userId here; agent sockets filter self-echo
          // by their own userId, so the visitor's contactId never collides.
          userId: ctx.contactId,
          userName: contactName,
        });
        return;
      }
      try { socket.close(1003, 'unsupported'); } catch { /* ignore */ }
    });

    socket.on('close', () => {
      ctx.unsubscribe();
    });

    // Liveness ping + token expiry check
    let pongAlive = true;
    socket.on('pong', () => {
      pongAlive = true;
    });
    const ping = setInterval(() => {
      if (ctx.expiresAtMs && Date.now() >= ctx.expiresAtMs) {
        try {
          socket.close(4401, 'token expired');
        } catch {
          /* ignore */
        }
        return;
      }
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
    }, 30_000);
    socket.on('close', () => clearInterval(ping));
  });
}
