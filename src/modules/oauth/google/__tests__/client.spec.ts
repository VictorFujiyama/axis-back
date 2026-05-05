import { describe, expect, it, vi } from 'vitest';
import { exchangeCode, GoogleOAuthError } from '../client.js';

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
