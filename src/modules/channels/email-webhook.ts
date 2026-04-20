import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema } from '@blossom/db';
import { constantTimeEqualStr } from '../../crypto';
import { config as appConfig } from '../../config';
import { ingestWithHooks } from './post-ingest';

const inboxParam = z.object({ inboxId: z.string().uuid() });

/**
 * Minimal schema for Postmark Inbound webhook payload.
 * Reference: https://postmarkapp.com/developer/user-guide/inbound/parse-an-email
 */
const postmarkInbound = z
  .object({
    MessageID: z.string().min(1),
    From: z.string().email(),
    FromName: z.string().optional(),
    Subject: z.string().default(''),
    TextBody: z.string().optional(),
    StrippedTextReply: z.string().optional(),
    HtmlBody: z.string().optional(),
    Headers: z
      .array(z.object({ Name: z.string(), Value: z.string() }))
      .optional()
      .default([]),
  })
  .passthrough();

function headerValue(
  headers: { Name: string; Value: string }[],
  name: string,
): string | undefined {
  const found = headers.find((h) => h.Name.toLowerCase() === name.toLowerCase());
  return found?.Value;
}

/** Parse RFC 5322 `<a@b> <c@d>` → ['<a@b>', '<c@d>']. */
function parseMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^>]+>/g) ?? [];
}

/**
 * Checks Authentication-Results header for SPF/DKIM failures. Postmark
 * populates this for inbound; we reject hard failures to prevent From-spoofing
 * combined with forged In-Reply-To (thread hijacking).
 */
function hasAuthFailure(headers: { Name: string; Value: string }[]): boolean {
  const authResults = headerValue(headers, 'Authentication-Results') ?? '';
  return /spf=fail/i.test(authResults) || /dkim=fail/i.test(authResults);
}

/** Strip HTML tags to produce a crude plaintext fallback — no sanitizer lib yet. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function emailChannelRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhooks/email/:inboxId',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { inboxId } = inboxParam.parse(req.params);

      const [inbox] = await app.db
        .select()
        .from(schema.inboxes)
        .where(and(eq(schema.inboxes.id, inboxId), isNull(schema.inboxes.deletedAt)))
        .limit(1);

      if (!inbox || !inbox.enabled || inbox.channelType !== 'email') {
        return reply.notFound('Inbox not found or not configured for email');
      }

      // Auth via shared secret — preferred via `X-Webhook-Secret` header
      // (query string leaks to proxy/access logs); ?secret= is a fallback.
      const expectedSecret =
        inbox.config && typeof inbox.config === 'object'
          ? (inbox.config as { webhookSecret?: string }).webhookSecret
          : undefined;

      if (!expectedSecret) {
        if (appConfig.NODE_ENV === 'production') {
          app.log.error({ inboxId }, 'email webhook: missing webhookSecret in production');
          return reply.unauthorized('Webhook secret required');
        }
        app.log.warn({ inboxId }, 'email webhook: no secret configured (accepted in dev)');
      } else {
        const headerSecret = req.headers['x-webhook-secret'];
        const querySecret = new URL(
          req.url,
          `http://${req.headers.host ?? 'x'}`,
        ).searchParams.get('secret');
        const provided =
          typeof headerSecret === 'string' ? headerSecret : querySecret;
        if (!provided || !constantTimeEqualStr(provided, expectedSecret)) {
          app.log.warn({ inboxId, ip: req.ip }, 'email webhook: invalid shared secret');
          return reply.unauthorized('Invalid shared secret');
        }
      }

      const body = postmarkInbound.parse(req.body);

      // Reject spoofed inbound to prevent thread hijacking via forged From + In-Reply-To.
      if (hasAuthFailure(body.Headers)) {
        app.log.warn(
          { inboxId, from: body.From, messageId: body.MessageID },
          'email: SPF/DKIM fail — refusing',
        );
        return reply.code(202).send({ accepted: false, reason: 'auth-fail' });
      }

      const inReplyTo = headerValue(body.Headers, 'In-Reply-To');
      const references = headerValue(body.Headers, 'References');
      const threadHints = [
        ...parseMessageIds(inReplyTo),
        ...parseMessageIds(references),
      ];

      // Prefer stripped reply (Postmark does quote-removal); fallback to full text;
      // last resort is HTML body converted to plaintext.
      const content =
        body.StrippedTextReply?.trim() ||
        body.TextBody?.trim() ||
        (body.HtmlBody ? htmlToText(body.HtmlBody) : '') ||
        '(sem conteúdo)';

      const fromEmail = body.From.toLowerCase();
      const name = body.FromName?.trim() || fromEmail.split('@')[0];

      const result = await ingestWithHooks(
        app,
        {
          inboxId,
          channel: 'email',
          from: {
            identifier: fromEmail,
            name,
            email: fromEmail,
            metadata: {},
          },
          content,
          contentType: 'text',
          channelMsgId: body.MessageID,
          threadHints,
          metadata: {
            subject: body.Subject,
            headers: body.Headers.filter((h) =>
              /^(from|to|subject|date|message-id|in-reply-to|references|authentication-results)$/i.test(
                h.Name,
              ),
            ),
            htmlBodyPresent: !!body.HtmlBody,
          },
        },
        inbox.config,
        inbox.defaultBotId,
      );

      if (result.blocked) {
        return reply.code(200).send({ accepted: false, reason: 'blocked' });
      }

      return reply.code(result.deduped ? 200 : 201).send({
        contactId: result.contactId,
        conversationId: result.conversationId,
        messageId: result.messageId,
        deduped: result.deduped,
      });
    },
  );
}
