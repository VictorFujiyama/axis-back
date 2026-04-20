#!/usr/bin/env node
/**
 * E2E Telegram adapter — inbound webhook (with/without secret), dedup, outbound
 * via mock Telegram API, contact identity persistence.
 */
import { createServer } from 'node:http';

const API = 'http://localhost:3200';
const stamp = Date.now();
let fails = 0;
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

async function tgPost(path, body, secret) {
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['x-telegram-bot-api-secret-token'] = secret;
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

// Mock Telegram API
let tgRequests = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {/* */}
    tgRequests.push({ url: req.url, body: parsed });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: Math.floor(Math.random() * 1_000_000) } }));
  });
});
await new Promise((r) => mock.listen(3298, r));
console.log('mock Telegram on :3298');

try {
  const token = await login();
  const botToken = `bot-tok-${stamp}`;
  const webhookSecret = `wh-sec-${stamp}`;

  // Create Telegram inbox
  let r = await api('/api/v1/inboxes', {
    method: 'POST',
    body: {
      name: `TG ${stamp}`,
      channelType: 'telegram',
      config: { apiBase: 'http://localhost:3298' },
      secrets: { botToken, webhookSecret },
    },
  }, token);
  assert(r.status === 201, `create tg inbox (${r.status})`);
  const inbox = await r.json();

  // Inbound message with valid secret
  const update = {
    update_id: stamp + 1,
    message: {
      message_id: 1,
      from: { id: 55555, first_name: 'João', username: 'joaotg' },
      chat: { id: 55555, type: 'private' },
      text: 'Olá do Telegram!',
    },
  };
  r = await tgPost(`/webhooks/telegram/${inbox.id}`, update, webhookSecret);
  assert(r.status === 201, `inbound with secret (${r.status})`);
  const body1 = await r.json();
  assert(body1.conversationId, 'conversation created');

  // Dedup (same update)
  r = await tgPost(`/webhooks/telegram/${inbox.id}`, update, webhookSecret);
  assert(r.status === 200, `dedup (${r.status})`);
  assert((await r.json()).deduped, 'deduped flag');

  // Invalid secret
  r = await tgPost(`/webhooks/telegram/${inbox.id}`, { ...update, update_id: stamp + 2 }, 'wrong-secret');
  assert(r.status === 401, `bad secret → 401 (${r.status})`);

  // Missing secret (dev mode: warn but accept? in our impl: 401 when secret configured)
  r = await tgPost(`/webhooks/telegram/${inbox.id}`, { ...update, update_id: stamp + 3 }, undefined);
  assert(r.status === 401, `missing secret → 401 (${r.status})`);

  // Outbound send
  tgRequests = [];
  r = await api(`/api/v1/conversations/${body1.conversationId}/messages`, {
    method: 'POST',
    body: { content: `resposta ${stamp}` },
  }, token);
  assert(r.status === 201, `outbound send (${r.status})`);

  // Wait for worker
  for (let i = 0; i < 40 && tgRequests.length === 0; i++) {
    await new Promise((res) => setTimeout(res, 100));
  }
  // There might be leftover replays; find our own
  const mine = tgRequests.find((x) => x.body?.text === `resposta ${stamp}`);
  assert(mine, `mock Telegram received this run's outbound (total=${tgRequests.length})`);
  if (mine) {
    assert(mine.url.startsWith(`/bot${botToken}/sendMessage`), `url ok (${mine.url})`);
    assert(mine.body.chat_id === '55555', `chat_id correct (${mine.body.chat_id})`);
  }

  // Non-message update (edited_message) — should be 204 no-op
  r = await tgPost(
    `/webhooks/telegram/${inbox.id}`,
    { update_id: stamp + 99, edited_message: { text: 'x' } },
    webhookSecret,
  );
  assert(r.status === 204, `non-message update → 204 (${r.status})`);

  if (fails === 0) console.log('\nALL GREEN');
  else { console.log(`\n${fails} FAILURES`); process.exit(1); }
} finally {
  mock.close();
}
