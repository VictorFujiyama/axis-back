import { describe, expect, it, vi } from 'vitest';
import {
  exchangeCode,
  getUserInfo,
  GoogleOAuthError,
  InvalidGrantError,
  refreshAccessToken,
  revokeToken,
} from '../client.js';

const baseCreds = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://test.example.com/callback',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('exchangeCode', () => {
  it('exchanges an auth code for tokens, hitting the Google token endpoint with the right form body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: 'ya29.test',
        refresh_token: '1//rtoken',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
      }),
    );

    const out = await exchangeCode('AUTH_CODE', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    });

    expect(out).toEqual({
      refreshToken: '1//rtoken',
      accessToken: 'ya29.test',
      expiresIn: 3599,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code')).toBe('AUTH_CODE');
    expect(body.get('client_id')).toBe(baseCreds.clientId);
    expect(body.get('client_secret')).toBe(baseCreds.clientSecret);
    expect(body.get('redirect_uri')).toBe(baseCreds.redirectUri);
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('throws GoogleOAuthError carrying status + upstream error code on 4xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Bad Request' },
        400,
      ),
    );
    const err = await exchangeCode('BAD', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).status).toBe(400);
    expect((err as GoogleOAuthError).code).toBe('invalid_grant');
  });

  it('throws when the 200 response is missing required token fields', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'x' }));
    await expect(
      exchangeCode('X', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...baseCreds,
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });

  it('configures an AbortSignal on the fetch call (15s timeout)', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      return jsonResponse({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 1,
      });
    });
    await exchangeCode('X', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it('refuses to call fetch when client credentials are not configured', async () => {
    const fetchImpl = vi.fn();
    await expect(
      exchangeCode('X', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wraps network/abort errors in GoogleOAuthError with code "network"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = await exchangeCode('X', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).code).toBe('network');
  });
});

describe('refreshAccessToken', () => {
  it('refreshes an access token, posting grant_type=refresh_token to the Google token endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: 'ya29.refreshed',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
      }),
    );

    const out = await refreshAccessToken('1//rtoken', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    });

    expect(out).toEqual({
      accessToken: 'ya29.refreshed',
      expiresIn: 3599,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('refresh_token')).toBe('1//rtoken');
    expect(body.get('client_id')).toBe(baseCreds.clientId);
    expect(body.get('client_secret')).toBe(baseCreds.clientSecret);
    expect(body.get('grant_type')).toBe('refresh_token');
    // refresh flow does not need redirect_uri (Google ignores it; absence is fine)
    expect(body.get('code')).toBeNull();
  });

  it('throws typed InvalidGrantError on 4xx with error="invalid_grant"', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        400,
      ),
    );
    const err = await refreshAccessToken('STALE', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(InvalidGrantError);
    // sub-class of GoogleOAuthError, so callers can still catch the parent
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as InvalidGrantError).status).toBe(400);
    expect((err as InvalidGrantError).code).toBe('invalid_grant');
    expect((err as InvalidGrantError).name).toBe('InvalidGrantError');
  });

  it('throws generic GoogleOAuthError (NOT InvalidGrantError) on other 4xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'unauthorized_client' }, 401),
    );
    const err = await refreshAccessToken('X', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect(err).not.toBeInstanceOf(InvalidGrantError);
    expect((err as GoogleOAuthError).status).toBe(401);
    expect((err as GoogleOAuthError).code).toBe('unauthorized_client');
  });

  it('throws when the 200 response is missing access_token or expires_in', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'x' }));
    await expect(
      refreshAccessToken('X', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...baseCreds,
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });

  it('configures an AbortSignal on the fetch call (15s timeout)', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      return jsonResponse({ access_token: 'a', expires_in: 1 });
    });
    await refreshAccessToken('X', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it('refuses to call fetch when client credentials are not configured', async () => {
    const fetchImpl = vi.fn();
    await expect(
      refreshAccessToken('X', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(GoogleOAuthError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wraps network/abort errors in GoogleOAuthError with code "network"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = await refreshAccessToken('X', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...baseCreds,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).code).toBe('network');
  });
});

describe('getUserInfo', () => {
  it('GETs the userinfo endpoint with a Bearer token and returns the email', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        sub: '1234567890',
        email: 'support@example.com',
        email_verified: true,
        name: 'Support',
      }),
    );

    const out = await getUserInfo('ya29.access', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ email: 'support@example.com' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://www.googleapis.com/oauth2/v3/userinfo');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ya29.access',
    );
    expect((init.headers as Record<string, string>).Accept).toBe(
      'application/json',
    );
    // GET should not have a body
    expect(init.body).toBeUndefined();
  });

  it('throws GoogleOAuthError carrying status 401 when the access token is invalid', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 401,
            message: 'Invalid Credentials',
            status: 'UNAUTHENTICATED',
          },
        },
        401,
      ),
    );
    const err = await getUserInfo('STALE', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).status).toBe(401);
  });

  it('throws when the 200 response is missing email', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sub: '1234567890', email_verified: true }),
    );
    const err = await getUserInfo('ya29.x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).code).toBe('invalid_response');
  });

  it('configures an AbortSignal on the fetch call (15s timeout)', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      return jsonResponse({ email: 'x@example.com' });
    });
    await getUserInfo('ya29.x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it('wraps network/abort errors in GoogleOAuthError with code "network"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const err = await getUserInfo('ya29.x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect((err as GoogleOAuthError).code).toBe('network');
  });

  it('does not require client_id/client_secret/redirect_uri (no GOOGLE_OAUTH_* config used)', async () => {
    // Note: this is a behavioral guard — getUserInfo authenticates via the access
    // token alone, so it must not fail with "config_missing" when oauth env is unset.
    const fetchImpl = vi.fn(async () => jsonResponse({ email: 'a@b.com' }));
    await expect(
      getUserInfo('ya29.x', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ email: 'a@b.com' });
  });
});

describe('revokeToken', () => {
  function makeLogger() {
    return {
      warn: vi.fn(),
    };
  }

  it('POSTs to the revoke endpoint with the refresh token as a query parameter', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await revokeToken('1//rtoken', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://oauth2.googleapis.com/revoke?token=1%2F%2Frtoken');
    expect(init.method).toBe('POST');
  });

  it('resolves silently on a 200 response (best-effort, no log)', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      revokeToken('1//rtoken', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resolves on a 4xx response and logs a warning (best-effort, never throws)', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'invalid_token' }, 400),
    );
    await expect(
      revokeToken('STALE', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // payload contains the upstream status; never the raw refresh token
    const [payload] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload.status).toBe(400);
    expect(JSON.stringify(payload)).not.toContain('STALE');
  });

  it('resolves on a network/abort error and logs a warning (never throws)', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(
      revokeToken('R', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('configures an AbortSignal on the fetch call (15s timeout)', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      return new Response('', { status: 200 });
    });
    await revokeToken('R', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it('does not require client_id/client_secret/redirect_uri (no GOOGLE_OAUTH_* config used)', async () => {
    // The revoke endpoint authenticates the request by the token itself; it does
    // not need the OAuth client credentials.
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await expect(
      revokeToken('R', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it('works without an injected logger (default no-op logger)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'invalid_token' }, 400),
    );
    await expect(
      revokeToken('R', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});
