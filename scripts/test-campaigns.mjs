#!/usr/bin/env node
/**
 * E2E Campanhas — cria campanha com inbox API + tag, starta, verifica que
 * mensagens foram disparadas, report agrega sent. Usa inbox do tipo 'api' pra
 * não depender de canal externo.
 */
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

const token = await login();

// Create api inbox
let r = await api('/api/v1/inboxes', {
  method: 'POST',
  body: { name: `campaign-inbox-${stamp}`, channelType: 'api', secrets: { apiToken: 'tok-' + stamp } },
}, token);
assert(r.status === 201, `create inbox (${r.status})`);
const inbox = await r.json();

// Create tag
r = await api('/api/v1/tags', { method: 'POST', body: { name: `campaign-${stamp}` } }, token);
assert(r.status === 201, `create tag (${r.status})`);
const tag = await r.json();

// Create contacts with identities on this channel + tagged
const contactIds = [];
for (let i = 0; i < 3; i++) {
  r = await api('/api/v1/contacts', {
    method: 'POST',
    body: {
      name: `C${stamp}-${i}`,
      email: `c${stamp}_${i}@test.local`,
      identities: [{ channel: 'api', identifier: `api-id-${stamp}-${i}` }],
    },
  }, token);
  if (r.status === 201) {
    const c = await r.json();
    contactIds.push(c.id);
    await api(`/api/v1/contacts/${c.id}/tags`, { method: 'POST', body: { tagIds: [tag.id] } }, token);
  }
}
assert(contactIds.length === 3, `created 3 contacts (got ${contactIds.length})`);

// Preview
r = await api('/api/v1/campaigns/preview', {
  method: 'POST',
  body: { inboxId: inbox.id, tagIds: [tag.id] },
}, token);
const preview = await r.json();
assert(preview.count === 3, `preview counts 3 (got ${preview.count})`);

// Create campaign
r = await api('/api/v1/campaigns', {
  method: 'POST',
  body: {
    name: `Campanha ${stamp}`,
    inboxId: inbox.id,
    tagIds: [tag.id],
    template: 'Olá {{contato.nome}}! Promoção especial.',
  },
}, token);
assert(r.status === 201, `create campaign (${r.status})`);
const campaign = await r.json();
assert(campaign.status === 'draft', `status = draft (${campaign.status})`);

// Start
r = await api(`/api/v1/campaigns/${campaign.id}/start`, { method: 'POST' }, token);
assert(r.status === 200, `start (${r.status})`);

// Poll until recipientCount populated
let running = null;
for (let i = 0; i < 50; i++) {
  await new Promise((res) => setTimeout(res, 200));
  r = await api(`/api/v1/campaigns/${campaign.id}`, {}, token);
  running = await r.json();
  if (running.recipientCount === 3) break;
}
assert(running.recipientCount === 3, `recipientCount = 3 (got ${running?.recipientCount})`);

// Poll until all sent
let final = null;
for (let i = 0; i < 50; i++) {
  await new Promise((res) => setTimeout(res, 300));
  r = await api(`/api/v1/campaigns/${campaign.id}`, {}, token);
  final = await r.json();
  const sent = final.report?.sent ?? 0;
  if (sent === 3) break;
}
assert(final?.report?.sent === 3, `3 sent in report (got ${final?.report?.sent})`);

// WhatsApp requires templateId
r = await api('/api/v1/inboxes', {
  method: 'POST',
  body: { name: `wa-test-${stamp}`, channelType: 'whatsapp' },
}, token);
const waInbox = await r.json();
r = await api('/api/v1/campaigns', {
  method: 'POST',
  body: { name: 'no template', inboxId: waInbox.id, tagIds: [tag.id], template: 'oi' },
}, token);
assert(r.status === 400, `whatsapp without templateId → 400 (${r.status})`);

if (fails === 0) console.log('\nALL GREEN');
else { console.log(`\n${fails} FAILURES`); process.exit(1); }
