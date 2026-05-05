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

export interface ExchangeCodeResult {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
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
