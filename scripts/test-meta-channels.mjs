#!/usr/bin/env node
/**
 * E2E Instagram + Messenger adapters via Twilio.
 * Uses the same signature verification as WhatsApp (shared helper).
 */
import { createServer } from 'node:http';
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
function twilioSig(authToken, fullUrl, params) {
  const keys = Object.keys(params).sort();
  const concat = keys.map((k) => `${k}${params[k] ?? ''}`).join('');
  return createHmac('sha1', authToken).update(fullUrl + concat).digest('base64');
}
async function postForm(path, params, sig) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(sig ? { 'x-twilio-signature': sig } : {}),
    },
    body: body.toString(),
  });
}

// Mock Twilio
const twilioRequests = [];
const mock = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const params = Object.fromEntries(new URLSearchParams(body).entries());
    twilioRequests.push({ url: req.url, params });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SM' + Math.random().toString(16).slice(2, 14), status: 'queued' }));
  });
});
await new Promise((r) => mock.listen(3299, r));

try {
  const token = await login();

  for (const prefix of ['instagram', 'messenger']) {
    console.log(`\n## ${prefix}`);
    const authToken = `${prefix}-tok-${stamp}`;

    let r = await api('/api/v1/inboxes', {
      method: 'POST',
      body: {
        name: `${prefix} ${stamp}`,
        channelType: prefix,
        config: { accountSid: 'ACshared', fromNumber: `${prefix}:6000000` },
        secrets: { authToken },
      },
    }, token);
    assert(r.status === 201, `create ${prefix} inbox (${r.status})`);
    const inbox = await r.json();

    // Inbound
    const inUrl = `${API}/webhooks/${prefix}/${inbox.id}`;
    const inParams = {
      MessageSid: `SMin${stamp}-${prefix}`,
      From: `${prefix}:9999${stamp % 1000}`,
      To: `${prefix}:6000000`,
      Body: `Oi do ${prefix}!`,
      NumMedia: '0',
      ProfileName: `Cliente ${prefix}`,
    };
    const sig = twilioSig(authToken, inUrl, inParams);
    r = await postForm(`/webhooks/${prefix}/${inbox.id}`, inParams, sig);
    assert(r.status === 201, `${prefix} inbound (${r.status})`);
    const body1 = await r.json();
    assert(body1.conversationId, `${prefix} conversation created`);

    // Bad sig
    r = await postForm(`/webhooks/${prefix}/${inbox.id}`, inParams, 'WRONG=');
    assert(r.status === 401, `${prefix} bad sig → 401 (${r.status})`);

    // Outbound
    const baseline = twilioRequests.length;
    r = await api(`/api/v1/conversations/${body1.conversationId}/messages`, {
      method: 'POST',
      body: { content: `resp ${prefix} ${stamp}` },
    }, token);
    assert(r.status === 201, `${prefix} outbound send (${r.status})`);

    // Wait for worker
    for (let i = 0; i < 50 && twilioRequests.length === baseline; i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    const mine = twilioRequests.slice(baseline).find((req) => req.params.Body === `resp ${prefix} ${stamp}`);
    assert(mine, `${prefix} mock Twilio received outbound (new=${twilioRequests.length - baseline})`);
    if (mine) {
      assert(mine.params.To.startsWith(`${prefix}:`), `${prefix} To prefix correct (${mine.params.To})`);
      assert(mine.params.From.startsWith(`${prefix}:`), `${prefix} From prefix correct (${mine.params.From})`);
    }

    // Status callback
    const stParams = { MessageSid: mine?.params ? 'sid-unused' : 'sid-x', MessageStatus: 'delivered' };
    const stUrl = `${API}/webhooks/${prefix}/${inbox.id}/status`;
    const stSig = twilioSig(authToken, stUrl, stParams);
    r = await postForm(`/webhooks/${prefix}/${inbox.id}/status`, stParams, stSig);
    assert(r.status === 204, `${prefix} status callback (${r.status})`);
  }

  if (fails === 0) console.log('\nALL GREEN');
  else { console.log(`\n${fails} FAILURES`); process.exit(1); }
} finally {
  mock.close();
}
