import { describe, expect, it, vi } from 'vitest';

// The script imports `../config` at module load (parses env — unavailable in
// the test env). Mock it like atlas-emit-contacts-bulk.spec.
vi.mock('../../config', () => ({ config: {} }));

import { parseArgs, runHandshake } from '../atlas-handshake';

const opts = {
  atlasUrl: 'https://atlas.example.com',
  orgId: '220ef5e0-47df-4493-ae4d-ec0dfe83cabd',
  hmacSecret: 'a'.repeat(48),
  now: 1_700_000_000_000, // deterministic signature timestamp
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('runHandshake', () => {
  it('signs an empty body and POSTs the two-header handshake', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, status: 'active', connector: { id: 'x' } }));
    const res = await runHandshake({ ...opts, atlasUrl: 'https://atlas.example.com/', fetchImpl });

    expect(res).toMatchObject({ ok: true, status: 'active' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://atlas.example.com/api/connectors/messaging/handshake'); // trailing slash trimmed
    expect(init.method).toBe('POST');
    expect(init.body).toBe(''); // empty body — sign == POST (L-607)
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-atlas-org-id']).toBe(opts.orgId);
    expect(headers['x-atlas-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });

  it('dry-run signs but never POSTs', async () => {
    const fetchImpl = vi.fn();
    const res = await runHandshake({ ...opts, dryRun: true, fetchImpl });
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid-signature' }, 401));
    await expect(runHandshake({ ...opts, fetchImpl })).rejects.toThrow(/401/);
  });

  it('throws when the body reports ok:false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, reason: 'connector-not-found' }));
    await expect(runHandshake({ ...opts, fetchImpl })).rejects.toThrow(/ok:false/);
  });

  it('returns the body but warns when status is not active', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, status: 'pending' }));
    const logs: string[] = [];
    const res = await runHandshake({ ...opts, fetchImpl, log: (m) => logs.push(m) });
    expect(res).toMatchObject({ ok: true, status: 'pending' });
    expect(logs.join('\n')).toMatch(/WARNING.*pending/);
  });
});

describe('parseArgs', () => {
  it('detects --dry-run', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(parseArgs([])).toEqual({ dryRun: false });
  });
});
