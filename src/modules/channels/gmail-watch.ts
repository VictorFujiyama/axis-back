/**
 * Gmail Push: registra/renova `users.watch()` numa inbox Gmail.
 *
 * `users.watch()` instrui o Gmail a publicar notifications no nosso Pub/Sub
 * topic sempre que o histórico da conta mudar. Cada registro expira em
 * ~7 dias — cron diário (gmail-watch-renew) chama isto pra todas inboxes
 * ativas pra evitar expiração.
 *
 * Idempotente do lado Google: re-chamar watch() na mesma conta pra mesmo
 * topic só "renova" a expiração e devolve o mesmo `historyId`.
 *
 * Spec: https://developers.google.com/gmail/api/guides/push#initial_watch_request
 */
import type { FastifyInstance } from 'fastify';
import { schema } from '@blossom/db';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { getValidAccessToken, type GmailInboxLike } from '../oauth/google/tokens.js';

const WATCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/watch';

export interface GmailWatchResult {
  /** Cursor do histórico no momento do watch — gmail-sync usa pra dedup. */
  historyId: string;
  /** Quando esta watch subscription expira (ms epoch). */
  expirationMs: number;
}

export class GmailWatchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not-configured'
      | 'http-error'
      | 'invalid-response',
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'GmailWatchError';
  }
}

export interface SetupGmailWatchDeps {
  /** Override fetch pra testes. */
  fetchImpl?: typeof fetch;
  /** Override token resolver pra testes. */
  getAccessToken?: (inbox: GmailInboxLike) => Promise<string>;
}

/**
 * Chama `users.watch()` na Gmail API pra esta inbox e persiste o estado
 * resultante (`gmailWatchExpirationMs`) na config.
 *
 * Filtra `labelIds: ['INBOX']` — só queremos notification pra mensagens
 * que chegam na caixa principal, não promoções/spam/etc.
 *
 * Lança `GmailWatchError` em falha. Caller (OAuth callback, cron renew)
 * trata: loga warn, continua flow normal (polling fallback cobre).
 */
export async function setupGmailWatch(
  app: FastifyInstance,
  inbox: GmailInboxLike,
  deps: SetupGmailWatchDeps = {},
): Promise<GmailWatchResult> {
  if (!config.GMAIL_PUBSUB_TOPIC) {
    throw new GmailWatchError(
      'GMAIL_PUBSUB_TOPIC env unset — push not configured',
      'not-configured',
    );
  }

  const tokenFn = deps.getAccessToken ?? ((i) => getValidAccessToken(app, i));
  const accessToken = await tokenFn(inbox);

  const fetchFn = deps.fetchImpl ?? fetch;
  const res = await fetchFn(WATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName: config.GMAIL_PUBSUB_TOPIC,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GmailWatchError(
      `Gmail watch() returned ${res.status}`,
      'http-error',
      res.status,
      body.slice(0, 500),
    );
  }

  const json = (await res.json().catch(() => null)) as
    | { historyId?: string; expiration?: string }
    | null;
  if (!json || !json.historyId || !json.expiration) {
    throw new GmailWatchError(
      `Gmail watch() response missing historyId/expiration: ${JSON.stringify(json)}`,
      'invalid-response',
    );
  }

  const expirationMs = Number(json.expiration);
  if (!Number.isFinite(expirationMs)) {
    throw new GmailWatchError(
      `Gmail watch() expiration not a number: ${json.expiration}`,
      'invalid-response',
    );
  }

  // Persistir watch state na config — gmail-watch-renew olha
  // `gmailWatchExpirationMs` pra decidir quando renovar (vs sempre).
  const currentCfg = (inbox.config ?? {}) as Record<string, unknown>;
  await app.db
    .update(schema.inboxes)
    .set({
      config: {
        ...currentCfg,
        gmailHistoryId: json.historyId,
        gmailWatchExpirationMs: expirationMs,
        gmailWatchEstablishedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(schema.inboxes.id, inbox.id));

  app.log.info(
    {
      inboxId: inbox.id,
      historyId: json.historyId,
      expirationMs,
      expiresIn: Math.round((expirationMs - Date.now()) / 1000),
    },
    'gmail-watch: setup OK',
  );

  return { historyId: json.historyId, expirationMs };
}
