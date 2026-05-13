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

describe('config — ATLAS_EVENTS_HMAC_SECRET', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to undefined when ATLAS_EVENTS_HMAC_SECRET is unset', async () => {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', '');
    delete process.env.ATLAS_EVENTS_HMAC_SECRET;

    const config = await loadFreshConfig();

    expect(config.ATLAS_EVENTS_HMAC_SECRET).toBeUndefined();
  });

  it('parses a 32-byte hex secret', async () => {
    const hex64 = 'a'.repeat(64);
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', hex64);

    const config = await loadFreshConfig();

    expect(config.ATLAS_EVENTS_HMAC_SECRET).toBe(hex64);
  });

  it('rejects a secret shorter than 16 characters', async () => {
    vi.stubEnv('ATLAS_EVENTS_HMAC_SECRET', 'too-short');

    await expect(loadFreshConfig()).rejects.toThrow();
  });
});

describe('config — MCP_SERVER_ENABLED + ATLAS_MCP_HMAC_SECRET', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults MCP_SERVER_ENABLED to false when unset', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', '');
    delete process.env.MCP_SERVER_ENABLED;

    const config = await loadFreshConfig();

    expect(config.MCP_SERVER_ENABLED).toBe(false);
    expect(config.ATLAS_MCP_HMAC_SECRET).toBeUndefined();
  });

  it('parses MCP_SERVER_ENABLED=true with a 32-byte hex secret + bearer key (default mode=both)', async () => {
    const hex64 = 'b'.repeat(64);
    const apiKey = 'k'.repeat(32);
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', hex64);
    vi.stubEnv('MCP_AXIS_API_KEY', apiKey);

    const config = await loadFreshConfig();

    expect(config.MCP_SERVER_ENABLED).toBe(true);
    expect(config.ATLAS_MCP_HMAC_SECRET).toBe(hex64);
    expect(config.MCP_AXIS_API_KEY).toBe(apiKey);
    expect(config.MCP_AUTH_MODE).toBe('both');
  });

  it('treats MCP_SERVER_ENABLED="false" as false (not coerced to true)', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'false');

    const config = await loadFreshConfig();

    expect(config.MCP_SERVER_ENABLED).toBe(false);
  });

  it('rejects MCP_SERVER_ENABLED=true with mode=hmac when ATLAS_MCP_HMAC_SECRET is unset', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('MCP_AUTH_MODE', 'hmac');
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', '');
    delete process.env.ATLAS_MCP_HMAC_SECRET;

    await expect(loadFreshConfig()).rejects.toThrow(
      /MCP_AUTH_MODE=hmac requires ATLAS_MCP_HMAC_SECRET/,
    );
  });

  it('rejects ATLAS_MCP_HMAC_SECRET shorter than 16 characters', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('MCP_AUTH_MODE', 'hmac');
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', 'too-short');

    await expect(loadFreshConfig()).rejects.toThrow();
  });
});

describe('config — MCP_AUTH_MODE + MCP_AXIS_API_KEY precheck', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults MCP_AUTH_MODE to "both"', async () => {
    const config = await loadFreshConfig();

    expect(config.MCP_AUTH_MODE).toBe('both');
  });

  it('rejects MCP_AUTH_MODE=both when MCP_AXIS_API_KEY is unset', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', 'h'.repeat(32));
    vi.stubEnv('MCP_AXIS_API_KEY', '');
    delete process.env.MCP_AXIS_API_KEY;

    await expect(loadFreshConfig()).rejects.toThrow(
      /MCP_AUTH_MODE=both requires MCP_AXIS_API_KEY/,
    );
  });

  it('rejects MCP_AUTH_MODE=bearer when MCP_AXIS_API_KEY is unset', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('MCP_AUTH_MODE', 'bearer');
    vi.stubEnv('MCP_AXIS_API_KEY', '');
    delete process.env.MCP_AXIS_API_KEY;

    await expect(loadFreshConfig()).rejects.toThrow(
      /MCP_AUTH_MODE=bearer requires MCP_AXIS_API_KEY/,
    );
  });

  it('boots with mode=both + MCP_AXIS_API_KEY set but HMAC secret unset (WARN, no throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('MCP_AXIS_API_KEY', 'k'.repeat(32));
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', '');
    delete process.env.ATLAS_MCP_HMAC_SECRET;

    const config = await loadFreshConfig();

    expect(config.MCP_AUTH_MODE).toBe('both');
    expect(config.ATLAS_MCP_HMAC_SECRET).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/MCP_AUTH_MODE=both but ATLAS_MCP_HMAC_SECRET unset/),
    );

    warnSpy.mockRestore();
  });

  it('boots silently with mode=bearer + HMAC secret unset (no warn, no throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('MCP_AUTH_MODE', 'bearer');
    vi.stubEnv('MCP_AXIS_API_KEY', 'k'.repeat(32));
    vi.stubEnv('ATLAS_MCP_HMAC_SECRET', '');
    delete process.env.ATLAS_MCP_HMAC_SECRET;

    const config = await loadFreshConfig();

    expect(config.MCP_AUTH_MODE).toBe('bearer');
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('rejects MCP_AXIS_API_KEY shorter than 16 characters', async () => {
    vi.stubEnv('MCP_SERVER_ENABLED', 'true');
    vi.stubEnv('MCP_AXIS_API_KEY', 'too-short');

    await expect(loadFreshConfig()).rejects.toThrow();
  });
});

describe('config — USE_PHASE_12_ENVELOPE + ATLAS_EVENTS_ENDPOINT', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults USE_PHASE_12_ENVELOPE to false', async () => {
    const config = await loadFreshConfig();

    expect(config.USE_PHASE_12_ENVELOPE).toBe(false);
  });

  it('treats USE_PHASE_12_ENVELOPE="false" as false (not coerced to true)', async () => {
    vi.stubEnv('USE_PHASE_12_ENVELOPE', 'false');

    const config = await loadFreshConfig();

    expect(config.USE_PHASE_12_ENVELOPE).toBe(false);
  });

  it('parses USE_PHASE_12_ENVELOPE="true" as true', async () => {
    vi.stubEnv('USE_PHASE_12_ENVELOPE', 'true');

    const config = await loadFreshConfig();

    expect(config.USE_PHASE_12_ENVELOPE).toBe(true);
  });

  it('defaults ATLAS_EVENTS_ENDPOINT to the Phase B path in prod', async () => {
    const config = await loadFreshConfig();

    expect(config.ATLAS_EVENTS_ENDPOINT).toBe('/api/messaging/events');
  });
});
