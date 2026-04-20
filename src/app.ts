import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config';
import dbPlugin from './plugins/db';
import redisPlugin from './plugins/redis';
import jwtPlugin from './plugins/jwt';
import queuePlugin from './plugins/queue';
import { registerWorkers } from './queue/workers';
import { registerAutomationEventHook } from './modules/automations/event-hook';
import { healthRoutes } from './modules/health/routes';
import { authRoutes } from './modules/auth/routes';
import { accountRoutes } from './modules/accounts/routes';
import { userRoutes } from './modules/users/routes';
import { inboxRoutes } from './modules/inboxes/routes';
import { tagRoutes } from './modules/tags/routes';
import { contactRoutes } from './modules/contacts/routes';
import { conversationRoutes } from './modules/conversations/routes';
import { messageRoutes } from './modules/messages/routes';
import { apiChannelRoutes } from './modules/channels/api-webhook';
import { emailChannelRoutes } from './modules/channels/email-webhook';
import { webchatChannelRoutes } from './modules/channels/webchat-webhook';
import { whatsappChannelRoutes } from './modules/channels/whatsapp-webhook';
import { telegramChannelRoutes } from './modules/channels/telegram-webhook';
import { registerTwilioChannel } from './modules/channels/twilio-webhook-shared';
import { widgetWsRoutes } from './realtime/widget-ws';
import { botRoutes } from './modules/bots/routes';
import { botRespondRoutes } from './modules/bots/respond';
import { botEventsRoutes } from './modules/bots/events-routes';
import { realtimeRoutes } from './realtime/ws-routes';
import { actionRoutes } from './modules/actions/routes';
import { analyticsRoutes } from './modules/analytics/routes';
import { auditRoutes } from './modules/audit/routes';
import { queueRoutes } from './modules/queues/routes';
import { cannedRoutes } from './modules/canned/routes';
import { searchRoutes } from './modules/search/routes';
import { draftRoutes } from './modules/drafts/routes';
import { notificationRoutes } from './modules/notifications/routes';
import { reactionRoutes } from './modules/reactions/routes';
import { bulkConversationRoutes } from './modules/conversations/bulk-routes';
import { linkPreviewRoutes } from './modules/link-preview/routes';
import { teamRoutes } from './modules/teams/routes';
import { slaRoutes } from './modules/sla/routes';
import { automationRoutes } from './modules/automations/routes';
import { csatRoutes } from './modules/csat/routes';
import { customFieldRoutes } from './modules/custom-fields/routes';
import { moderationRoutes } from './modules/moderation/routes';
import { apiKeyRoutes } from './modules/api-keys/routes';
import { publicApiRoutes } from './modules/public-api/routes';
import { webhookSubscriptionRoutes } from './modules/webhooks/routes';
import { campaignRoutes } from './modules/campaigns/routes';
import { registerWebhookEventHook } from './modules/webhooks/event-hook';
import { uploadRoutes } from './modules/uploads/routes';
import { loadModules } from './modules/plugins/loader';
import { modulesRoutes } from './modules/plugins/routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redact secrets from logs (Authorization headers, signatures, tokens).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-twilio-signature"]',
          'req.headers["x-blossom-signature"]',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.passwordHash',
          '*.secret',
          '*.apiToken',
          '*.refreshToken',
          '*.accessToken',
        ],
        censor: '[REDACTED]',
      },
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
    disableRequestLogging: false,
    trustProxy: true,
    genReqId: () =>
      `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  });

  // Twilio webhooks (WhatsApp, etc.) post application/x-www-form-urlencoded.
  // Fastify only parses JSON by default — add a minimal urlencoded parser.
  // Repeated keys become string[] so signature verification can concat every
  // value (Twilio's algorithm includes all occurrences, not just the last).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_req, body: string, done) => {
      try {
        const params = new URLSearchParams(body);
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of params.entries()) {
          const existing = out[k];
          if (existing === undefined) out[k] = v;
          else if (Array.isArray(existing)) existing.push(v);
          else out[k] = [existing, v];
        }
        done(null, out);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin, mobile, curl
      cb(null, config.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
  });
  await app.register(sensible);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  if (config.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Blossom Inbox API', version: '0.0.1' },
        servers: [{ url: `http://localhost:${config.PORT}` }],
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(jwtPlugin);
  await app.register(queuePlugin);

  // Register WebSocket plugin at root so multiple route plugins can declare WS endpoints.
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      handleProtocols: (protocols: Set<string>) => {
        const offered = [...protocols];
        return offered.find((p) => p.startsWith('jwt.')) ?? offered[0] ?? false;
      },
    },
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(userRoutes);
  await app.register(inboxRoutes);
  await app.register(tagRoutes);
  await app.register(contactRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(botRoutes);
  await app.register(botRespondRoutes);
  await app.register(botEventsRoutes);
  await app.register(apiChannelRoutes);
  await app.register(emailChannelRoutes);
  await app.register(webchatChannelRoutes);
  await app.register(whatsappChannelRoutes);
  await app.register(telegramChannelRoutes);
  registerTwilioChannel(app, 'instagram', 'instagram');
  registerTwilioChannel(app, 'messenger', 'messenger');
  await app.register(actionRoutes);
  await app.register(analyticsRoutes);
  await app.register(auditRoutes);
  await app.register(queueRoutes);
  await app.register(cannedRoutes);
  await app.register(searchRoutes);
  await app.register(draftRoutes);
  await app.register(notificationRoutes);
  await app.register(reactionRoutes);
  await app.register(bulkConversationRoutes);
  await app.register(linkPreviewRoutes);
  await app.register(teamRoutes);
  await app.register(slaRoutes);
  await app.register(automationRoutes);
  await app.register(csatRoutes);
  await app.register(customFieldRoutes);
  await app.register(moderationRoutes);
  await app.register(apiKeyRoutes);
  await app.register(publicApiRoutes);
  await app.register(webhookSubscriptionRoutes);
  await app.register(campaignRoutes);
  await app.register(realtimeRoutes);
  await app.register(widgetWsRoutes);
  await app.register(uploadRoutes);
  await app.register(modulesRoutes);

  // Load pluggable modules (ENABLED_MODULES) — after core routes so modules can
  // safely depend on app.requireAuth / app.db / app.queues decorators.
  await loadModules(app);

  // Spin up BullMQ workers AFTER all plugins/routes loaded.
  registerWorkers(app);

  // Automation rules subscribe to eventBus AFTER workers (so rule actions that
  // emit events land on properly-registered listeners).
  registerAutomationEventHook(app);

  // Outbound webhooks subscribe last — they shouldn't observe automation-
  // emitted events as new triggers (the automation hook already filters those).
  registerWebhookEventHook(app);

  return app;
}
