import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots/realtime');
mkdirSync(SHOTS, { recursive: true });

const log = (m) => console.log(`[smoke-rt] ${m}`);

log('seed');
execSync(
  `docker exec blossom-postgres psql -U blossom -d blossom -c "
    DELETE FROM messages; DELETE FROM conversation_tags; DELETE FROM conversations;
    DELETE FROM contact_identities; DELETE FROM contact_tags; DELETE FROM contacts;
    DELETE FROM bots; DELETE FROM inbox_members; DELETE FROM inboxes;
    DELETE FROM tags; DELETE FROM users WHERE role='agent';" > /dev/null`,
  { shell: '/bin/bash' },
);
execSync('docker exec blossom-redis redis-cli FLUSHDB > /dev/null', { shell: '/bin/bash' });

const BASE = 'http://localhost:3200';
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'victorfujiyama@gmail.com', password: 'w170598' }),
}).then((r) => r.json());

const me = await fetch(`${BASE}/api/v1/auth/me`, {
  headers: { Authorization: `Bearer ${login.accessToken}` },
}).then((r) => r.json());

const inbox = await fetch(`${BASE}/api/v1/inboxes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({
    name: 'Site',
    channelType: 'api',
    config: {},
    secrets: { apiToken: 'rt_token' },
  }),
}).then((r) => r.json());

await fetch(`${BASE}/api/v1/inboxes/${inbox.id}/members`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({ userIds: [me.id] }),
});

await fetch(`${BASE}/webhooks/api/${inbox.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rt_token' },
  body: JSON.stringify({
    from: { identifier: 'visitor_1', name: 'João RT' },
    content: 'Mensagem inicial',
    channelMsgId: 'rt_m1',
  }),
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

log('1. login');
await page.goto('http://localhost:3201/login');
await page.fill('input[type=email]', 'victorfujiyama@gmail.com');
await page.fill('input[type=password]', 'w170598');
await page.click('button[type=submit]');
await page.waitForURL(/\/inbox/);
await page.waitForSelector('[data-testid="conversation-list"]');

log('2. wait for realtime indicator green');
await page.waitForFunction(
  () => {
    const ind = document.querySelector('[data-testid="realtime-indicator"]');
    return ind?.classList.contains('bg-green-500');
  },
  { timeout: 5_000 },
);
await page.screenshot({ path: `${SHOTS}/01-connected.png` });
log('   ✅ WS conectado (badge verde)');

log('3. open conversation');
await page.locator('[data-testid^="conversation-item-"]').first().click();
await page.waitForSelector('[data-testid="messages-list"]');
const initialMsgs = await page.locator('[data-testid^="message-"]').count();
log(`   initial messages on screen: ${initialMsgs}`);

log('4. external webhook with new contact message');
await fetch(`${BASE}/webhooks/api/${inbox.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rt_token' },
  body: JSON.stringify({
    from: { identifier: 'visitor_1' },
    content: '🔥 mensagem em tempo real',
    channelMsgId: 'rt_m2',
  }),
});

log('5. wait for new message to appear without refresh');
await page.waitForFunction(
  (initial) => document.querySelectorAll('[data-testid^="message-"]').length > initial,
  initialMsgs,
  { timeout: 5_000 },
);
await page.screenshot({ path: `${SHOTS}/02-new-message-realtime.png` });
log('   ✅ nova mensagem apareceu sem refresh');

log('6. send reply from agent → triggers another realtime event');
const beforeReply = await page.locator('[data-testid^="message-"]').count();
// Need to assign self first
const assignBtn = page.locator('[data-testid="assign-me-btn"]');
if (await assignBtn.count()) await assignBtn.click();
await page.fill('[data-testid="message-input"]', 'Resposta em tempo real');
await page.click('[data-testid="send-btn"]');
await page.waitForFunction(
  (b) => document.querySelectorAll('[data-testid^="message-"]').length > b,
  beforeReply,
  { timeout: 5_000 },
);
await page.screenshot({ path: `${SHOTS}/03-agent-reply.png` });

log('7. open second tab in same context (shares localStorage)');
const page2 = await ctx.newPage();
const errors2 = [];
page2.on('console', (msg) => {
  if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors2.push(msg.text());
});
await page2.goto('http://localhost:3201/inbox');
await page2.waitForSelector('[data-testid="conversation-list"]');
await page2.locator('[data-testid^="conversation-item-"]').first().click();
await page2.waitForSelector('[data-testid="messages-list"]');
const tab2InitialMsgs = await page2.locator('[data-testid^="message-"]').count();

await fetch(`${BASE}/webhooks/api/${inbox.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rt_token' },
  body: JSON.stringify({
    from: { identifier: 'visitor_1' },
    content: 'msg pros 2 tabs',
    channelMsgId: 'rt_m3',
  }),
});
await page2.waitForFunction(
  (b) => document.querySelectorAll('[data-testid^="message-"]').length > b,
  tab2InitialMsgs,
  { timeout: 5_000 },
);
await page2.screenshot({ path: `${SHOTS}/04-tab2-received.png` });
log('   ✅ tab 2 também recebeu via WS');

log(`---`);
log(`tab1 errors: ${errors.length}, tab2 errors: ${errors2.length}`);
errors.forEach((e) => log(`  ✗ tab1: ${e}`));
errors2.forEach((e) => log(`  ✗ tab2: ${e}`));

await browser.close();
if (errors.length || errors2.length) process.exit(2);
log('🎉 realtime smoke OK');
