#!/usr/bin/env node
/**
 * E2E outbound webhooks. Spins up a local receiver on :3399 that records
 * incoming deliveries, creates a subscription pointing at it, sends a message
 * which emits message.created → asserts receiver gets payload + valid signature.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = 'http://localhost:3200';
let fails = 0;
const stamp = Date.now();
function assert(cond, msg) { if (cond) console.log('OK:', msg); else { console.error('FAIL:', msg); fails++; } }

async function login() {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'victorfujiyama@gmail.com', password: 'w170598' }),
  });
  return (await r.json()).accessToken;
}
async function api(path, opts = {}, token) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body && typeof opts.body !== 'string') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(`${API}${path}`, { ...opts, headers });
}

function verifySig(header, body, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const received = [];
const secret = `wh-secret-${stamp}-strong-enough-for-validation`;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({
      url: req.url,
      sig: req.headers['x-blossom-signature'],
      event: req.headers['x-blossom-event'],
      body,
    });
    res.writeHead(200).end();
  });
});
await new Promise((r) => server.listen(3399, r));
console.log('mock receiver on :3399');

try {
  const token = await login();

  // Create subscription
  let r = await api('/api/v1/webhook-subscriptions', {
    method: 'POST',
    body: { name: 'e2e-test', url: 'http://localhost:3399/wh', secret, events: ['message.created'] },
  }, token);
  assert(r.status === 201, `create subscription (${r.status})`);
  const sub = await r.json();

  // Need a conversation to fire an event
  r = await api('/api/v1/conversations?limit=1', {}, token);
  const conv = (await r.json()).items[0];
  if (!conv) {
    console.log('SKIP: no conversation available');
    process.exit(0);
  }
  if (conv.status === 'resolved') {
    await api(`/api/v1/conversations/${conv.id}/reopen`, { method: 'POST' }, token);
  }

  // Send a message → emits message.created → webhook delivery
  await api(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST',
    body: { content: `webhook test ${stamp}` },
  }, token);

  // Wait up to 5s for delivery
  for (let i = 0; i < 50 && received.length === 0; i++) {
    await new Promise((res) => setTimeout(res, 100));
  }
  assert(received.length >= 1, `webhook delivered (got ${received.length})`);
  if (received.length > 0) {
    const d = received[0];
    assert(d.event === 'message.created', `event header (${d.event})`);
    assert(verifySig(d.sig, d.body, secret), 'signature verifies with secret');
    assert(!verifySig(d.sig, d.body, 'wrong-secret-for-test'), 'signature rejects wrong secret');
    const parsed = JSON.parse(d.body);
    assert(parsed.event === 'message.created', 'body has event field');
    assert(parsed.data?.conversationId === conv.id, 'body has conversationId');
  }

  // Cleanup
  await api(`/api/v1/webhook-subscriptions/${sub.id}`, { method: 'DELETE' }, token);

  if (fails === 0) console.log('\nALL GREEN');
  else { console.log(`\n${fails} FAILURES`); process.exit(1); }
} finally {
  server.close();
}
