#!/usr/bin/env node
/**
 * E2E Bloco 02 — Canned Responses, Search, Snooze reopen, Draft autosave.
 * Assumes backend on :3200, admin victorfujiyama@gmail.com / w170598.
 */
import { createHmac } from 'node:crypto';

const API = 'http://localhost:3200';
let fails = 0;
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
  const j = await r.json();
  return j.accessToken;
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

// ==================== P1: CANNED RESPONSES ====================
console.log('\n## P1 Canned Responses');

const stamp = Date.now();
const globShortcut = `bv${stamp}`;
const persShortcut = `ass${stamp}`;

let r = await api('/api/v1/canned-responses', {
  method: 'POST',
  body: { name: 'Boas-vindas', shortcut: globShortcut, content: 'Olá {{contato.nome}}, como posso ajudar?', visibility: 'global' },
}, token);
assert(r.status === 201, `create global (201, got ${r.status})`);
const canned1 = await r.json();

r = await api('/api/v1/canned-responses', {
  method: 'POST',
  body: { name: 'Pessoal', shortcut: persShortcut, content: 'Abraços, {{agente.nome}}', visibility: 'personal' },
}, token);
assert(r.status === 201, `create personal (201, got ${r.status})`);

// Duplicate shortcut in same scope
r = await api('/api/v1/canned-responses', {
  method: 'POST',
  body: { name: 'dup', shortcut: globShortcut, content: 'x', visibility: 'global' },
}, token);
assert(r.status === 409, `duplicate shortcut → 409 (got ${r.status})`);

// List
r = await api('/api/v1/canned-responses', {}, token);
const listed = await r.json();
assert(listed.items.some((c) => c.shortcut === globShortcut), 'list includes global');
assert(listed.items.some((c) => c.shortcut === persShortcut), 'list includes own personal');

// Update
r = await api(`/api/v1/canned-responses/${canned1.id}`, {
  method: 'PATCH',
  body: { content: 'updated' },
}, token);
assert(r.status === 200, `patch (200, got ${r.status})`);

// Delete
r = await api(`/api/v1/canned-responses/${canned1.id}`, { method: 'DELETE' }, token);
assert(r.status === 204, `delete (204, got ${r.status})`);

// ==================== P4: SEARCH ====================
console.log('\n## P4 Search');

// Need at least one message/contact to find. Grab any existing conversation.
r = await api('/api/v1/contacts?limit=1', {}, token);
const contactsList = await r.json();
if (contactsList.items?.length) {
  const name = contactsList.items[0].name;
  if (name && name.length >= 2) {
    r = await api(`/api/v1/search?q=${encodeURIComponent(name.split(' ')[0])}`, {}, token);
    assert(r.status === 200, `search (200, got ${r.status})`);
    const res = await r.json();
    assert(Array.isArray(res.messages) && Array.isArray(res.contacts) && Array.isArray(res.conversations),
      'search returns all 3 kinds');
    assert(res.contacts.some((c) => c.id === contactsList.items[0].id),
      'search found seeded contact by name');
  } else {
    console.log('SKIP: no searchable contact name');
  }
} else {
  console.log('SKIP: no contacts to search');
}

// Search too short
r = await api('/api/v1/search?q=a', {}, token);
assert(r.status === 400, `short query rejected (got ${r.status})`);

// ==================== P8: SNOOZE ====================
console.log('\n## P8 Snooze + reopen worker');

// Need a conversation — use any existing one
r = await api('/api/v1/conversations?limit=1', {}, token);
const convs = await r.json();
if (convs.items?.length) {
  const conv = convs.items[0];
  // Set status open first if resolved
  if (conv.status === 'resolved') {
    await api(`/api/v1/conversations/${conv.id}/reopen`, { method: 'POST' }, token);
  }
  // Snooze 2 seconds into future
  const until = new Date(Date.now() + 2000).toISOString();
  r = await api(`/api/v1/conversations/${conv.id}/snooze`, {
    method: 'POST',
    body: { until },
  }, token);
  assert(r.status === 200, `snooze (200, got ${r.status})`);
  const snoozed = await r.json();
  assert(snoozed.status === 'snoozed', 'status becomes snoozed');

  // Wait for worker
  let reopened = false;
  for (let i = 0; i < 40 && !reopened; i++) {
    await new Promise((res) => setTimeout(res, 200));
    r = await api(`/api/v1/conversations/${conv.id}`, {}, token);
    const j = await r.json();
    if (j.status === 'pending' || j.status === 'open') reopened = true;
  }
  assert(reopened, 'worker reopened snoozed conversation');

  // ==================== P10: DRAFT ====================
  console.log('\n## P10 Draft autosave');

  r = await api(`/api/v1/conversations/${conv.id}/draft`, {
    method: 'PUT',
    body: { content: 'rascunho teste', isPrivateNote: false },
  }, token);
  assert(r.status === 204, `draft save (204, got ${r.status})`);

  r = await api(`/api/v1/conversations/${conv.id}/draft`, {}, token);
  const draft = await r.json();
  assert(draft.content === 'rascunho teste', 'draft restored');

  // Empty content deletes draft
  r = await api(`/api/v1/conversations/${conv.id}/draft`, {
    method: 'PUT',
    body: { content: '' },
  }, token);
  assert(r.status === 204, `empty draft (204, got ${r.status})`);
  r = await api(`/api/v1/conversations/${conv.id}/draft`, {}, token);
  const draft2 = await r.json();
  assert(draft2.content === '', 'empty draft returns empty');

  // Draft survives send → clear
  r = await api(`/api/v1/conversations/${conv.id}/draft`, {
    method: 'PUT',
    body: { content: 'before send' },
  }, token);
  assert(r.status === 204, 'draft pre-send saved');
} else {
  console.log('SKIP: no conversations available for snooze/draft');
}

if (fails === 0) {
  console.log('\nALL GREEN');
} else {
  console.log(`\n${fails} FAILURES`);
  process.exit(1);
}
