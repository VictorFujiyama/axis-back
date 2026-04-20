import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots/dashboard');
mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[dash] ${m}`);

log('seed');
execSync(
  `docker exec blossom-postgres psql -U blossom -d blossom -c "
    DELETE FROM action_logs; DELETE FROM custom_actions;
    DELETE FROM messages; DELETE FROM conversation_tags; DELETE FROM conversations;
    DELETE FROM contact_identities; DELETE FROM contact_tags; DELETE FROM contacts;
    DELETE FROM bots; DELETE FROM inbox_members; DELETE FROM inboxes;
    DELETE FROM tags; DELETE FROM users WHERE role='agent';" > /dev/null`,
  { shell: '/bin/bash' },
);
execSync('docker exec blossom-redis redis-cli FLUSHDB > /dev/null', { shell: '/bin/bash' });

const BASE = 'http://localhost:3200';
const FRONT = 'http://localhost:3201';

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'victorfujiyama@gmail.com', password: 'w170598' }),
}).then((r) => r.json());
const me = await fetch(`${BASE}/api/v1/auth/me`, {
  headers: { Authorization: `Bearer ${login.accessToken}` },
}).then((r) => r.json());

// Seed: 1 inbox + admin member + N inbound messages + agent reply
const inbox = await fetch(`${BASE}/api/v1/inboxes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({
    name: 'Site',
    channelType: 'api',
    config: {},
    secrets: { apiToken: 'tok' },
  }),
}).then((r) => r.json());

await fetch(`${BASE}/api/v1/inboxes/${inbox.id}/members`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({ userIds: [me.id] }),
});

// 5 contacts, each with 2 messages → 10 inbound + 5 outbound
log('seeding 10 inbound + 5 outbound msgs');
for (let i = 0; i < 5; i++) {
  await fetch(`${BASE}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify({
      from: { identifier: `vis_${i}`, name: `Cliente ${i}` },
      content: `Olá ${i}`,
      channelMsgId: `seed_${i}_a`,
    }),
  });
  await fetch(`${BASE}/webhooks/api/${inbox.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify({
      from: { identifier: `vis_${i}` },
      content: `Mais info ${i}`,
      channelMsgId: `seed_${i}_b`,
    }),
  });
}
const convList = await fetch(`${BASE}/api/v1/conversations?status=open&limit=20`, {
  headers: { Authorization: `Bearer ${login.accessToken}` },
}).then((r) => r.json());
log(`  ${convList.items.length} conversations created`);

for (const c of convList.items.slice(0, 3)) {
  await fetch(`${BASE}/api/v1/conversations/${c.id}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
    body: JSON.stringify({ userId: me.id }),
  });
  await fetch(`${BASE}/api/v1/conversations/${c.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
    body: JSON.stringify({ content: `Resposta da Felipe` }),
  });
  await fetch(`${BASE}/api/v1/conversations/${c.id}/resolve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
}
log('seed done');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

log('1. login');
await page.goto(`${FRONT}/login`);
await page.fill('input[type=email]', 'victorfujiyama@gmail.com');
await page.fill('input[type=password]', 'w170598');
await page.click('button[type=submit]');
await page.waitForURL(/\/inbox/);

log('2. abre dashboard via sidebar');
await page.goto(`${FRONT}/dashboard`);
await page.waitForSelector('[data-testid="dashboard-page"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="kpi-received"]')?.textContent?.match(/\d+/),
  { timeout: 5_000 },
);
await page.screenshot({ path: `${SHOTS}/01-dashboard-loaded.png`, fullPage: true });

log('3. validar KPIs');
const received = await page.locator('[data-testid="kpi-received"]').textContent();
const sent = await page.locator('[data-testid="kpi-sent"]').textContent();
const created = await page.locator('[data-testid="kpi-created"]').textContent();
const resolved = await page.locator('[data-testid="kpi-resolved"]').textContent();
log(`   recebidas=${received?.match(/\d+/)?.[0]}, enviadas=${sent?.match(/\d+/)?.[0]}, criadas=${created?.match(/\d+/)?.[0]}, resolvidas=${resolved?.match(/\d+/)?.[0]}`);
if (!received?.includes('10')) throw new Error(`recebidas esperava 10`);
if (!sent?.includes('3')) throw new Error(`enviadas esperava 3`);
if (!created?.includes('5')) throw new Error(`criadas esperava 5`);
if (!resolved?.includes('3')) throw new Error(`resolvidas esperava 3`);
log('   ✅ KPIs corretos');

log('4. tabela by-agent mostra Felipe');
const agentTable = await page.locator('[data-testid="table-by-agent"]').textContent();
if (!agentTable?.includes('Admin')) throw new Error(`tabela by-agent vazia: ${agentTable}`);
log('   ✅ atendente listado');

log('5. tabela by-inbox mostra Site/api');
const inboxTable = await page.locator('[data-testid="table-by-inbox"]').textContent();
if (!inboxTable?.includes('Site')) throw new Error('inbox não listado');
log('   ✅ inbox listado');

log('6. mudar período');
await page.selectOption('[data-testid="dashboard-range"]', '30');
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/02-range-30.png`, fullPage: true });

log(`---`);
log(`errors: ${errors.length}`);
errors.forEach((e) => log(`  ✗ ${e}`));
await browser.close();
if (errors.length > 0) process.exit(2);
log('🎉 dashboard smoke OK');
