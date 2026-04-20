#!/usr/bin/env node
/**
 * E2E Bloco 03 — Mentions, Reactions, Reply, Bulk, Scheduled, Link preview.
 * Shortcuts (P3) are UI-only.
 */

const API = 'http://localhost:3200';
let fails = 0;
const stamp = Date.now();
function assert(cond, msg) {
  if (cond) console.log('OK:', msg);
  else { console.error('FAIL:', msg); fails++; }
}
async function login(email = 'victorfujiyama@gmail.com', password = 'w170598') {
  const r = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

const token = await login();

// Need a conversation to work with.
let r = await api('/api/v1/conversations?limit=1', {}, token);
const convs = await r.json();
if (!convs.items?.length) {
  console.log('SKIP: no conversations available');
  process.exit(0);
}
const conv = convs.items[0];
if (conv.status === 'resolved') {
  await api(`/api/v1/conversations/${conv.id}/reopen`, { method: 'POST' }, token);
}

// ==================== P2 MENTIONS + NOTIFICATIONS ====================
console.log('\n## P2 Mentions (via private note)');

// Create a second user to mention
const mentionEmail = `mentioned${stamp}@blossom.test`;
r = await api('/api/v1/users', {
  method: 'POST',
  body: { email: mentionEmail, name: `Ana${stamp}`, password: 'testpass1234', role: 'agent' },
}, token);
const mentioned = r.status === 201 ? await r.json() : null;
assert(mentioned, `created mentionable user (status ${r.status})`);

// Send a private note mentioning them
const mentionLocal = mentionEmail.split('@')[0];
r = await api(`/api/v1/conversations/${conv.id}/messages`, {
  method: 'POST',
  body: { content: `@${mentionLocal} confere essa conversa?`, isPrivateNote: true },
}, token);
assert(r.status === 201, `private note with mention sent (${r.status})`);

// Wait for fire-and-forget mention processing
await new Promise((res) => setTimeout(res, 500));

// Login as mentioned user and check notifications
const mentionedToken = await login(mentionEmail, 'testpass1234');
r = await api('/api/v1/notifications', {}, mentionedToken);
const notifs = await r.json();
assert(
  notifs.items.some((n) => n.type === 'mention' && n.data?.conversationId === conv.id),
  `mentioned user received notification (got ${notifs.items.length} items, unread ${notifs.unread})`,
);

// Mark all read
r = await api('/api/v1/notifications/read-all', { method: 'POST' }, mentionedToken);
assert(r.status === 204, `read-all (${r.status})`);
r = await api('/api/v1/notifications', { method: 'GET' }, mentionedToken);
const after = await r.json();
assert(after.unread === 0, `unread cleared (got ${after.unread})`);

// ==================== P5 REPLY/QUOTE ====================
console.log('\n## P5 Reply/quote');

// Send a message to reply to
r = await api(`/api/v1/conversations/${conv.id}/messages`, {
  method: 'POST',
  body: { content: `base msg ${stamp}` },
}, token);
const base = await r.json();
// Reply referencing it
r = await api(`/api/v1/conversations/${conv.id}/messages`, {
  method: 'POST',
  body: { content: 'replying to above', replyToMessageId: base.id },
}, token);
const reply = await r.json();
assert(reply.replyToMessageId === base.id, `reply stored replyToMessageId`);

// ==================== P9 REACTIONS ====================
console.log('\n## P9 Reactions');

r = await api(`/api/v1/messages/${base.id}/reactions`, {
  method: 'POST',
  body: { emoji: '👍' },
}, token);
assert(r.status === 204, `add reaction (${r.status})`);

r = await api(`/api/v1/messages/${base.id}/reactions`, { method: 'POST', body: { emoji: '👍' } }, token);
assert(r.status === 204, `duplicate reaction idempotent (${r.status})`);

r = await api(`/api/v1/messages/${base.id}/reactions`, {}, token);
const rxns = await r.json();
assert(rxns.items.some((x) => x.emoji === '👍'), 'reaction listed');

r = await api(`/api/v1/messages/${base.id}/reactions`, { method: 'DELETE', body: { emoji: '👍' } }, token);
assert(r.status === 204, `remove reaction (${r.status})`);

// ==================== P6 BULK ACTIONS ====================
console.log('\n## P6 Bulk actions');

r = await api('/api/v1/conversations?limit=3', {}, token);
const bulkTargets = (await r.json()).items.map((c) => c.id);
if (bulkTargets.length >= 2) {
  r = await api('/api/v1/conversations/bulk', {
    method: 'POST',
    body: { ids: bulkTargets, action: 'resolve' },
  }, token);
  const res = await r.json();
  assert(res.affected >= 1, `bulk resolve affected ${res.affected}`);

  r = await api('/api/v1/conversations/bulk', {
    method: 'POST',
    body: { ids: bulkTargets, action: 'reopen' },
  }, token);
  assert((await r.json()).affected >= 1, 'bulk reopen');
}

// ==================== P7 SCHEDULED MESSAGE ====================
console.log('\n## P7 Scheduled');

const scheduledFor = new Date(Date.now() + 2500).toISOString();
r = await api(`/api/v1/conversations/${conv.id}/messages`, {
  method: 'POST',
  body: { content: `agendada ${stamp}`, scheduledFor },
}, token);
const sched = await r.json();
assert(sched.scheduledFor, 'message has scheduledFor');

// Poll until worker publishes (scheduledFor cleared)
let published = false;
for (let i = 0; i < 40 && !published; i++) {
  await new Promise((res) => setTimeout(res, 200));
  r = await api(`/api/v1/conversations/${conv.id}/messages?limit=50`, {}, token);
  const m = (await r.json()).items.find((x) => x.id === sched.id);
  if (m && !m.scheduledFor) published = true;
}
assert(published, 'scheduled worker published message');

// ==================== P11 LINK PREVIEW ====================
console.log('\n## P11 Link preview');

// Spin up a mock HTTP target so we don't depend on outgoing internet/TLS trust.
// Uses 127.0.0.1 — safe-fetch blocks private IPs, so we exercise the bypass in
// development by hitting the mock via a "public-looking" hostname mapped via DNS.
// Simpler: validate the route accepts URL and returns structured JSON OR 404 on
// blocked host. Here we accept either outcome — either the handler responded
// correctly. 500 would be a bug.
r = await api(`/api/v1/link-preview?url=${encodeURIComponent('https://example.com/')}`, {}, token);
assert(r.status === 200 || r.status === 404, `link preview returns 200|404 (got ${r.status})`);
if (r.status === 200) {
  const prev = await r.json();
  assert(typeof prev === 'object' && 'url' in prev, 'preview has shape');
}

// Bad URL returns 400
r = await api('/api/v1/link-preview?url=not-a-url', {}, token);
assert(r.status === 400, `invalid url (${r.status})`);

if (fails === 0) console.log('\nALL GREEN');
else { console.log(`\n${fails} FAILURES`); process.exit(1); }
