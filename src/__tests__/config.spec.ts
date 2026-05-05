import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `src/config.ts` parses `process.env` at import time as a side effect.
// Use `vi.resetModules` + `vi.stubEnv` to test against fresh imports without
// polluting the singleton seen by the rest of the test suite.

async function loadFreshConfig() {
  vi.resetModules();
  const mod = await import('../config.js');
  return mod.config;
}

describe('config — GOOGLE_OAUTH_*', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('parses when all three Google OAuth vars are set', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '1234.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'GOCSPX-xxxxxxxxxxxx');
    vi.stubEnv(
      'GOOGLE_OAUTH_REDIRECT_URI',
      'https://axis-back.onrender.com/api/v1/oauth/google/callback',
    );

    const config = await loadFreshConfig();

    expect(config.GOOGLE_OAUTH_CLIENT_ID).toBe(
      '1234.apps.googleusercontent.com',
    );
    expect(config.GOOGLE_OAUTH_CLIENT_SECRET).toBe('GOCSPX-xxxxxxxxxxxx');
    expect(config.GOOGLE_OAUTH_REDIRECT_URI).toBe(
      'https://axis-back.onrender.com/api/v1/oauth/google/callback',
    );
  });

  it('does not throw when all three Google OAuth vars are missing', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
    vi.stubEnv('GOOGLE_OAUTH_REDIRECT_URI', '');
    // Empty-string env vars behave like "set but empty"; clear them so the
    // optional() schema sees `undefined`.
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;

    const config = await loadFreshConfig();

    expect(config.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(config.GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(config.GOOGLE_OAUTH_REDIRECT_URI).toBeUndefined();
  });

  it('rejects a non-URL GOOGLE_OAUTH_REDIRECT_URI', async () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'id');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'secret');
    vi.stubEnv('GOOGLE_OAUTH_REDIRECT_URI', 'not-a-url');

    await expect(loadFreshConfig()).rejects.toThrow();
  });
});
