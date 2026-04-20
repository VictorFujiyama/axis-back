import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots/actions-ui');
mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[actions-ui] ${m}`);

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
    name: 'Logística',
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

await fetch(`${BASE}/webhooks/api/${inbox.id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
  body: JSON.stringify({
    from: { identifier: 'joao_v', name: 'João' },
    content: 'Quero cancelar meu pedido',
    channelMsgId: 'm_action_1',
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

log('2. settings → actions');
await page.goto('http://localhost:3201/settings/actions');
await page.waitForSelector('[data-testid="actions-new-btn"]');
await page.screenshot({ path: `${SHOTS}/01-actions-empty.png` });

log('3. cria action via UI');
await page.click('[data-testid="actions-new-btn"]');
await page.waitForSelector('[data-testid="action-name-input"]');
await page.fill('[data-testid="action-name-input"]', 'cancelar_pedido');
await page.fill('[data-testid="action-label-input"]', 'Cancelar Pedido');
await page.fill('[data-testid="action-webhook-input"]', 'http://localhost:4200/');
await page.selectOption('[data-testid="action-inbox-select"]', inbox.id);
await page.screenshot({ path: `${SHOTS}/02-action-form.png` });
await page.click('[data-testid="action-submit-btn"]');
await page.waitForSelector('[data-testid="action-revealed-secret"]');
await page.screenshot({ path: `${SHOTS}/03-action-secret-revealed.png` });
log('   ✅ action criada e secret revelado');
await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid^="action-item-"]');

log('4. Pega secret via API pra subir mock server');
const allActions = await fetch(`${BASE}/api/v1/custom-actions`, {
  headers: { Authorization: `Bearer ${login.accessToken}` },
}).then((r) => r.json());
const actionRow = allActions.items[0];
// Rotate via API to get a fresh secret we can use
const rotated = await fetch(
  `${BASE}/api/v1/custom-actions/${actionRow.id}/rotate-secret`,
  { method: 'POST', headers: { Authorization: `Bearer ${login.accessToken}` } },
).then((r) => r.json());
log(`   secret pego pra mock: ${rotated.secret.slice(0, 20)}...`);

const mock = spawn('node', [resolve('scripts/mock-action-server.mjs')], {
  env: { ...process.env, ACTION_SECRET: rotated.secret, PORT: '4200' },
  stdio: 'pipe',
});
let mockReady = false;
mock.stdout.on('data', (d) => {
  if (d.toString().includes('listening')) mockReady = true;
});
for (let i = 0; i < 30 && !mockReady; i++) await new Promise((r) => setTimeout(r, 100));

log('5. abre a conversa no inbox e dispara action via UI');
await page.goto('http://localhost:3201/inbox');
await page.waitForSelector('[data-testid^="conversation-item-"]');
await page.locator('[data-testid^="conversation-item-"]').first().click();
await page.waitForSelector('[data-testid="action-buttons"]');
await page.screenshot({ path: `${SHOTS}/04-conv-with-actions.png` });

await page.click('[data-testid="run-action-cancelar_pedido"]');
await page.waitForSelector('[data-testid="run-action-submit"]');
await page.screenshot({ path: `${SHOTS}/05-action-run-modal.png` });

log('6. submit action');
await page.click('[data-testid="run-action-submit"]');
// Aguarda toast ou error
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/06-after-action.png` });

log('7. private note do action aparece na conversa');
const noteVisible = await page.locator('text=/Cancelar Pedido/').count();
log(`   ${noteVisible} ocorrências do texto "Cancelar Pedido" na tela`);

mock.kill();
await browser.close();

log(`---`);
log(`console errors: ${errors.length}`);
errors.forEach((e) => log(`  ✗ ${e}`));
if (errors.length > 0) process.exit(2);
log('🎉 actions UI smoke OK');
