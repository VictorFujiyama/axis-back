import { config } from '../../../config.js';

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

/**
 * Thrown by `refreshAccessToken` when Google responds with `error: 'invalid_grant'`.
 * Indicates the refresh token has been revoked or expired and the user must re-consent.
 */
export class InvalidGrantError extends GoogleOAuthError {
  constructor(message: string, status?: number) {
    super(message, status, 'invalid_grant');
    this.name = 'InvalidGrantError';
  }
}

export interface ExchangeCodeResult {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
}

export interface RefreshAccessTokenResult {
  accessToken: string;
  expiresIn: number;
}

export interface UserInfoResult {
  email: string;
}

export interface GoogleClientDeps {
  /** Override `fetch` for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override `config.GOOGLE_OAUTH_CLIENT_ID`. */
  clientId?: string;
  /** Override `config.GOOGLE_OAUTH_CLIENT_SECRET`. */
  clientSecret?: string;
  /** Override `config.GOOGLE_OAUTH_REDIRECT_URI`. */
  redirectUri?: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const FETCH_TIMEOUT_MS = 15_000;

interface ResolvedDeps {
  fetchImpl: typeof fetch;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function resolveDeps(deps: GoogleClientDeps): ResolvedDeps {
  const clientId = deps.clientId ?? config.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = deps.clientSecret ?? config.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = deps.redirectUri ?? config.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOAuthError(
      'GOOGLE_OAUTH_* env vars are not configured',
      undefined,
      'config_missing',
    );
  }
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    clientId,
    clientSecret,
    redirectUri,
  };
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * Exchanges an OAuth authorization code for refresh + access tokens.
 * Wraps `https://oauth2.googleapis.com/token` with a 15s abort.
 */
export async function exchangeCode(
  code: string,
  deps: GoogleClientDeps = {},
): Promise<ExchangeCodeResult> {
  const { fetchImpl, clientId, clientSecret, redirectUri } = resolveDeps(deps);

  const body = new URLSearchParams();
  body.set('code', code);
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('redirect_uri', redirectUri);
  body.set('grant_type', 'authorization_code');

  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleOAuthError(
      `network error: ${(err as Error).message}`,
      undefined,
      'network',
    );
  }

  const data = (await res.json().catch(() => ({}))) as TokenResponseBody;

  if (!res.ok) {
    throw new GoogleOAuthError(
      data.error_description ?? data.error ?? `google ${res.status}`,
      res.status,
      data.error,
    );
  }

  if (
    !data.access_token ||
    !data.refresh_token ||
    typeof data.expires_in !== 'number'
  ) {
    throw new GoogleOAuthError(
      'invalid token response from google',
      res.status,
      'invalid_response',
    );
  }

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Exchanges a refresh token for a new access token.
 * Wraps `https://oauth2.googleapis.com/token` with `grant_type=refresh_token` and a 15s abort.
 *
 * Throws `InvalidGrantError` (a sub-class of `GoogleOAuthError`) when the refresh token
 * has been revoked or expired (`error: 'invalid_grant'`) — the caller must trigger reauth.
 * Other 4xx responses surface as plain `GoogleOAuthError`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  deps: GoogleClientDeps = {},
): Promise<RefreshAccessTokenResult> {
  const { fetchImpl, clientId, clientSecret } = resolveDeps(deps);

  const body = new URLSearchParams();
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('refresh_token', refreshToken);
  body.set('grant_type', 'refresh_token');

  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleOAuthError(
      `network error: ${(err as Error).message}`,
      undefined,
      'network',
    );
  }

  const data = (await res.json().catch(() => ({}))) as TokenResponseBody;

  if (!res.ok) {
    const message = data.error_description ?? data.error ?? `google ${res.status}`;
    if (data.error === 'invalid_grant') {
      throw new InvalidGrantError(message, res.status);
    }
    throw new GoogleOAuthError(message, res.status, data.error);
  }

  if (!data.access_token || typeof data.expires_in !== 'number') {
    throw new GoogleOAuthError(
      'invalid token response from google',
      res.status,
      'invalid_response',
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

interface UserInfoResponseBody {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * Fetches the authenticated user's email from Google's userinfo endpoint.
 * Authenticates via the access token alone — no `GOOGLE_OAUTH_*` config required.
 */
export async function getUserInfo(
  accessToken: string,
  deps: Pick<GoogleClientDeps, 'fetchImpl'> = {},
): Promise<UserInfoResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(USERINFO_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleOAuthError(
      `network error: ${(err as Error).message}`,
      undefined,
      'network',
    );
  }

  const data = (await res.json().catch(() => ({}))) as UserInfoResponseBody & {
    error?: { message?: string; status?: string } | string;
  };

  if (!res.ok) {
    const errorMessage =
      typeof data.error === 'string'
        ? data.error
        : data.error?.message ?? `google ${res.status}`;
    throw new GoogleOAuthError(errorMessage, res.status);
  }

  if (!data.email) {
    throw new GoogleOAuthError(
      'invalid userinfo response from google',
      res.status,
      'invalid_response',
    );
  }

  return { email: data.email };
}

/** Minimal logger shape compatible with Fastify's `app.log`. */
export interface RevokeLogger {
  warn(payload: Record<string, unknown>, msg?: string): void;
}

const noopLogger: RevokeLogger = { warn: () => undefined };

/**
 * Revokes a Google refresh token (best-effort).
 *
 * Per spec, this is called when a Gmail inbox is deleted. The endpoint is fire-and-forget:
 * any non-2xx response, network error, or abort is logged and swallowed so that the caller
 * (the `DELETE /inboxes/:id` route) can still proceed with the soft-delete.
 *
 * Never throws. Never logs the refresh token itself.
 */
export async function revokeToken(
  refreshToken: string,
  deps: Pick<GoogleClientDeps, 'fetchImpl'> & { logger?: RevokeLogger } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? noopLogger;
  const url = `${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'gmail revokeToken: network error',
    );
    return;
  }

  if (!res.ok) {
    logger.warn(
      { status: res.status },
      'gmail revokeToken: non-2xx response',
    );
  }
}
