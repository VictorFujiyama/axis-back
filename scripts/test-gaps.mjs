#!/usr/bin/env node
/**
 * E2E cobrindo os 5 gaps declarados: SLA auto-reply, Rule engine event-hook,
 * CSAT trigger+parse automático, Custom Fields, Moderação/blocklist+rate-limit.
 *
 * Todos usam canal 'api' (bearer token) para não depender de Twilio/Telegram.
 */
import { createHmac } from 'node:crypto';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = await login();

// ==================== BLOCO 05: SLA AUTO-REPLY FORA DE HORÁRIO ====================
console.log('\n## Bloco 05: Auto-reply fora do horário');
{
  // Create inbox with businessHours configured so that NOW is outside.
  // Trick: set weekdays = none (empty). isWithinBusinessHours returns true when
  // no weekdays configured (default "always in hours"). Need to specify weekdays
  // but set from/to range that excludes current hour.
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay();
  // Cover every weekday 0-6 with a tight range that DOES NOT include currentHour.
  const outHour = (currentHour + 4) % 24;
  const outEnd = (currentHour + 5) % 24;
  const from = `${String(outHour).padStart(2, '0')}:00`;
  const to = `${String(outEnd).padStart(2, '0')}:00`;
  const config = {
    businessHours: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekdays: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, from, to })),
      outOfHoursReply: `Atendimento indisponível no momento ${stamp}`,
    },
  };
  const apiToken = `sla-tok-${stamp}`;
  let r = await api('/api/v1/inboxes', {
    method: 'POST',
    body: { name: `sla-test-${stamp}`, channelType: 'api', config, secrets: { apiToken } },
  }, token);
  assert(r.status === 201, `create inbox with BH (${r.status})`);
  const inbox = await r.json();

  // Inbound through the api webhook — triggers ingestWithHooks → post-ingest auto-reply.
  r = await fetch(`${API}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      from: { identifier: `sla-contact-${stamp}`, name: 'SLA Contato' },
      content: 'oi quero atendimento',
      channelMsgId: `sla-msg-${stamp}`,
    }),
  });
  assert(r.status === 201 || r.status === 200, `inbound (${r.status})`);
  const body = await r.json();

  // Poll conversation messages until auto-reply system message appears.
  let found = null;
  for (let i = 0; i < 40 && !found; i++) {
    await sleep(200);
    r = await api(`/api/v1/conversations/${body.conversationId}/messages?limit=50`, {}, token);
    const d = await r.json();
    found = d.items.find((m) => m.senderType === 'system' && m.content?.includes(`${stamp}`));
  }
  assert(found, `auto-reply system message emitted (found=${!!found})`);
}

// ==================== BLOCO 07: RULE ENGINE EVENT HOOK ====================
console.log('\n## Bloco 07: Rule engine event-hook');
{
  // Create tag + rule: when message.created with content containing "promocode",
  // add the tag to the conversation.
  let r = await api('/api/v1/tags', { method: 'POST', body: { name: `autotag-${stamp}` } }, token);
  const tag = await r.json();
  assert(tag.id, 'tag created');

  r = await api('/api/v1/automation-rules', {
    method: 'POST',
    body: {
      name: `rule-${stamp}`,
      enabled: true,
      trigger: 'message.created',
      conditions: [{ key: 'message.content', op: 'contains', value: `promocode-${stamp}` }],
      actions: [{ type: 'add_tag', tagId: tag.id }],
    },
  }, token);
  assert(r.status === 201, `create rule (${r.status})`);

  // Need a conversation. Grab any existing or reuse the SLA inbox one.
  r = await api('/api/v1/conversations?limit=1', {}, token);
  const conv = (await r.json()).items[0];
  assert(conv, 'conversation available');
  if (conv.status === 'resolved') {
    await api(`/api/v1/conversations/${conv.id}/reopen`, { method: 'POST' }, token);
  }

  // Send a message whose content matches the condition — emits message.created.
  r = await api(`/api/v1/conversations/${conv.id}/messages`, {
    method: 'POST',
    body: { content: `texto com promocode-${stamp} aqui` },
  }, token);
  assert(r.status === 201, `send triggering msg (${r.status})`);

  // Poll until tag is applied.
  let tagged = false;
  for (let i = 0; i < 40 && !tagged; i++) {
    await sleep(200);
    r = await api(`/api/v1/conversations/${conv.id}`, {}, token);
    const d = await r.json();
    tagged = Array.isArray(d.tags) && d.tags.some((t) => t.id === tag.id);
  }
  assert(tagged, 'rule fired and add_tag applied');
}

// ==================== BLOCO 08: CSAT TRIGGER + PARSE ====================
console.log('\n## Bloco 08: CSAT trigger automático + parse');
{
  const apiToken = `csat-tok-${stamp}`;
  let r = await api('/api/v1/inboxes', {
    method: 'POST',
    body: {
      name: `csat-test-${stamp}`,
      channelType: 'api',
      config: { csat: { enabled: true, prompt: `Avalie o atendimento 1-5 (${stamp})` } },
      secrets: { apiToken },
    },
  }, token);
  assert(r.status === 201, `csat inbox (${r.status})`);
  const inbox = await r.json();

  // Inbound to create contact+conversation
  r = await fetch(`${API}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      from: { identifier: `csat-c-${stamp}`, name: 'CSAT Contato' },
      content: 'primeira msg',
      channelMsgId: `csat-m1-${stamp}`,
    }),
  });
  const conv = await r.json();

  // Resolve — should enqueue CSAT prompt 1min later. Assign first so resolvedBy is set.
  await api(`/api/v1/conversations/${conv.conversationId}/assign`, {
    method: 'POST', body: { userId: (await (await api('/api/v1/users/me', {}, token)).json()).id },
  }, token);
  r = await api(`/api/v1/conversations/${conv.conversationId}/resolve`, { method: 'POST' }, token);
  assert(r.status === 200, `resolve (${r.status})`);

  // Check prompt message was staged with scheduledFor in the future.
  let promptMsg = null;
  for (let i = 0; i < 20 && !promptMsg; i++) {
    await sleep(200);
    r = await api(`/api/v1/conversations/${conv.conversationId}/messages?limit=50`, {}, token);
    const d = await r.json();
    promptMsg = d.items.find((m) => m.senderType === 'system' && m.content?.includes(`${stamp}`));
  }
  assert(promptMsg, `CSAT prompt staged (scheduledFor=${promptMsg?.scheduledFor})`);
  assert(promptMsg?.scheduledFor, 'prompt has scheduledFor');

  // Simulate contact reply "5" — post-ingest parser should record csat_responses.
  await fetch(`${API}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      from: { identifier: `csat-c-${stamp}`, name: 'CSAT Contato' },
      content: '5',
      channelMsgId: `csat-m2-${stamp}`,
    }),
  });

  // Poll csat responses
  let csatResp = null;
  for (let i = 0; i < 30 && !csatResp; i++) {
    await sleep(200);
    r = await api(`/api/v1/conversations/${conv.conversationId}/csat`, {}, token);
    const d = await r.json();
    if (d.items?.length) csatResp = d.items[0];
  }
  assert(csatResp?.score === 5, `CSAT score 5 recorded (got ${csatResp?.score})`);
  assert(csatResp?.kind === 'csat', 'kind=csat (score≤5)');
}

// ==================== BLOCO 09: CUSTOM FIELDS ====================
console.log('\n## Bloco 09: Custom Fields');
{
  let r = await api('/api/v1/custom-field-defs', {
    method: 'POST',
    body: { key: `cnpj_${stamp}`, label: 'CNPJ', type: 'text', required: false, order: 1 },
  }, token);
  assert(r.status === 201, `create text field (${r.status})`);
  const def = await r.json();

  // select type requires options
  r = await api('/api/v1/custom-field-defs', {
    method: 'POST',
    body: { key: `no_opts_${stamp}`, label: 'X', type: 'select' },
  }, token);
  assert(r.status === 400, `select without options → 400 (${r.status})`);

  // valid select
  r = await api('/api/v1/custom-field-defs', {
    method: 'POST',
    body: { key: `seg_${stamp}`, label: 'Segmento', type: 'select', options: ['SMB', 'Enterprise'] },
  }, token);
  assert(r.status === 201, `select with options (${r.status})`);

  // Update
  r = await api(`/api/v1/custom-field-defs/${def.id}`, {
    method: 'PATCH', body: { label: 'CNPJ Atualizado' },
  }, token);
  assert(r.status === 200, `patch (${r.status})`);

  // List returns both
  r = await api('/api/v1/custom-field-defs', {}, token);
  const list = await r.json();
  assert(list.items.filter((f) => f.key.endsWith(`_${stamp}`)).length === 2, 'list includes 2 created');

  // Soft delete (dup key not conflict after revive? skip — just check delete ok)
  r = await api(`/api/v1/custom-field-defs/${def.id}`, { method: 'DELETE' }, token);
  assert(r.status === 204, `delete (${r.status})`);
}

// ==================== BLOCO 10: MODERAÇÃO + RATE LIMIT ====================
console.log('\n## Bloco 10: Moderação + rate limit');
{
  const apiToken = `mod-tok-${stamp}`;
  let r = await api('/api/v1/inboxes', {
    method: 'POST',
    body: { name: `mod-test-${stamp}`, channelType: 'api', secrets: { apiToken } },
  }, token);
  const inbox = await r.json();

  // Create contact via first inbound
  r = await fetch(`${API}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      from: { identifier: `mod-c-${stamp}` },
      content: 'hi',
      channelMsgId: `mod-m1-${stamp}`,
    }),
  });
  const first = await r.json();
  assert(first.contactId, 'contact created');

  // Block the contact
  r = await api(`/api/v1/contacts/${first.contactId}/block`, {
    method: 'POST', body: { reason: `spam ${stamp}` },
  }, token);
  assert(r.status === 200, `block (${r.status})`);

  // Inbound after block should be dropped (result.blocked=true)
  r = await fetch(`${API}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      from: { identifier: `mod-c-${stamp}` },
      content: 'ainda aqui',
      channelMsgId: `mod-m2-${stamp}`,
    }),
  });
  const blockedResp = await r.json();
  assert(blockedResp.accepted === false && blockedResp.reason === 'blocked', `blocked inbound drops (${JSON.stringify(blockedResp)})`);

  // Blocklist list endpoint
  r = await api('/api/v1/blocklist', {}, token);
  const bl = await r.json();
  assert(bl.items.some((b) => b.id === first.contactId), 'contact appears in blocklist');

  // Unblock + flag
  r = await api(`/api/v1/contacts/${first.contactId}/unblock`, { method: 'POST' }, token);
  assert(r.status === 204, `unblock (${r.status})`);
  r = await api(`/api/v1/contacts/${first.contactId}/flag`, { method: 'POST', body: { note: 'teste' } }, token);
  assert(r.status === 204, `flag (${r.status})`);

  // Rate limit: inject 35 inbound from a fresh identity. The 31st+ should be dropped
  // (limit = 30/min). We count how many are accepted.
  const rlId = `rl-${stamp}`;
  let accepted = 0;
  let dropped = 0;
  for (let i = 0; i < 35; i++) {
    r = await fetch(`${API}/webhooks/api/${inbox.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({
        from: { identifier: rlId },
        content: `m${i}`,
        channelMsgId: `rl-${stamp}-${i}`,
      }),
    });
    const b = await r.json().catch(() => ({}));
    if (b.accepted === false && b.reason === 'blocked') dropped++;
    else accepted++;
  }
  assert(accepted <= 30, `rate limit caps accepted ≤30 (got accepted=${accepted})`);
  assert(dropped >= 5, `rate limit drops 5+ (got dropped=${dropped})`);
}

if (fails === 0) console.log('\nALL GREEN');
else { console.log(`\n${fails} FAILURES`); process.exit(1); }
