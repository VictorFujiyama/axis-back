import { and, eq, asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { eventBus, type RealtimeEvent } from '../../realtime/event-bus';
import { ActionSchema, runActions, type Action } from './execute';

/**
 * Subscribe to eventBus and run matching automation rules.
 * MVP: supports triggers `message.created`, `conversation.created`,
 * `conversation.assigned`. Conditions are simple key=value checks on the event.
 *
 * Rules re-entrancy: rules can call `send_message` which emits another
 * `message.created` — we prevent loops by ignoring events whose senderType
 * is 'system' (rules only act on contact/user/bot messages).
 */
export function registerAutomationEventHook(app: FastifyInstance): void {
  eventBus.onEvent(async (event) => {
    try {
      const trigger = eventToTrigger(event);
      if (!trigger) return;
      const conversationId = (event as { conversationId?: string }).conversationId;
      if (!conversationId) return;
      // Loop guards:
      //  1. Events tagged source='automation' (emitted by our own actions)
      //  2. System-authored messages (healthy default for CSAT/out-of-hours replies)
      if ((event as { source?: string }).source === 'automation') return;
      if (
        event.type === 'message.created' &&
        event.message.senderType === 'system'
      ) {
        return;
      }

      const rules = await app.db
        .select()
        .from(schema.automationRules)
        .where(
          and(
            eq(schema.automationRules.trigger, trigger),
            eq(schema.automationRules.enabled, true),
          ),
        )
        .orderBy(asc(schema.automationRules.order));

      for (const rule of rules) {
        const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
        if (!evaluateConditions(conditions as Condition[], event)) continue;
        const actions = safeParseActions(rule.actions);
        if (!actions.length) continue;
        try {
          await runActions(actions, { conversationId, actorUserId: null, app });
          app.log.info(
            { ruleId: rule.id, conversationId, trigger },
            'automation: rule executed',
          );
        } catch (err) {
          app.log.warn(
            { err, ruleId: rule.id, conversationId },
            'automation: rule failed',
          );
        }
      }
    } catch (err) {
      app.log.warn({ err }, 'automation: event hook failed');
    }
  });
}

function eventToTrigger(event: RealtimeEvent): string | null {
  switch (event.type) {
    case 'message.created': return 'message.created';
    case 'conversation.created': return 'conversation.created';
    case 'conversation.assigned': return 'conversation.assigned';
    default: return null;
  }
}

type Condition = { key: string; op: 'eq' | 'ne' | 'contains'; value: unknown };

function evaluateConditions(conditions: Condition[], event: RealtimeEvent): boolean {
  if (conditions.length === 0) return true;
  for (const c of conditions) {
    const actual = getByPath(event, c.key);
    const match = evalOp(actual, c.op, c.value);
    if (!match) return false;
  }
  return true;
}

function evalOp(actual: unknown, op: Condition['op'], expected: unknown): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'contains': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      return actual.toLowerCase().includes(expected.toLowerCase());
    }
    default: return false;
  }
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    // Block prototype-walking tokens — use hasOwn so only own properties resolve.
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined;
    if (cur && typeof cur === 'object' && Object.hasOwn(cur as object, p)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function safeParseActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const item of raw) {
    const parsed = ActionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
