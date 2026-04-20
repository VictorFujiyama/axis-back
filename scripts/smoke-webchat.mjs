import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots/webchat');
mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[webchat] ${m}`);

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
const WIDGET_TOKEN = `wt_${Math.random().toString(36).slice(2)}_${Date.now()}`;

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
    name: 'Site WebChat',
    channelType: 'webchat',
    config: { widgetToken: WIDGET_TOKEN, primaryColor: '#7b3fa9', greeting: 'Olá! Como posso ajudar?' },
  }),
}).then((r) => r.json());
log(`inbox: ${inbox.id}`);

await fetch(`${BASE}/api/v1/inboxes/${inbox.id}/members`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({ userIds: [me.id] }),
});

const browser = await chromium.launch();
const errors = [];

// === VISITOR TAB (anonymous) ===
log('1. abre widget como visitante');
const visitorCtx = await browser.newContext({ viewport: { width: 400, height: 600 } });
const visitor = await visitorCtx.newPage();
visitor.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`visitor: ${msg.text()}`);
});

await visitor.goto(`${FRONT}/widget/${inbox.id}?token=${WIDGET_TOKEN}`);
await visitor.waitForSelector('[data-testid="widget-header"]');
await visitor.waitForTimeout(1000);
await visitor.screenshot({ path: `${SHOTS}/01-widget-loaded.png` });
const greetingVisible = await visitor.locator('text=Olá! Como posso ajudar?').count();
log(`   ✅ widget carregou (greeting visível: ${greetingVisible > 0})`);

log('2. visitante envia mensagem');
await visitor.fill('[data-testid="widget-input"]', 'Oi, preciso de ajuda com pedido');
await visitor.click('[data-testid="widget-send"]');
await visitor.waitForTimeout(800);
await visitor.screenshot({ path: `${SHOTS}/02-visitor-sent.png` });

// === ADMIN TAB ===
log('3. admin abre inbox');
const adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const admin = await adminCtx.newPage();
admin.on('console', (msg) => {
  if (msg.type() === 'error' && !/status of 401/.test(msg.text())) errors.push(`admin: ${msg.text()}`);
});

await admin.goto(`${FRONT}/login`);
await admin.fill('input[type=email]', 'victorfujiyama@gmail.com');
await admin.fill('input[type=password]', 'w170598');
await admin.click('button[type=submit]');
await admin.waitForURL(/\/inbox/);
await admin.waitForSelector('[data-testid^="conversation-item-"]', { timeout: 5_000 });
await admin.screenshot({ path: `${SHOTS}/03-admin-sees-conv.png` });
log('   ✅ admin vê a conversa');

log('4. admin abre conversa e responde');
await admin.locator('[data-testid^="conversation-item-"]').first().click();
await admin.waitForSelector('[data-testid="messages-list"]');
const assignBtn = admin.locator('[data-testid="assign-me-btn"]');
if (await assignBtn.count()) await assignBtn.click();
await admin.fill('[data-testid="message-input"]', 'Oi! Vou verificar seu pedido agora.');
await admin.click('[data-testid="send-btn"]');
await admin.waitForTimeout(800);
await admin.screenshot({ path: `${SHOTS}/04-admin-replied.png` });

log('5. visitante recebe a resposta em tempo real');
await visitor.waitForFunction(
  () =>
    Array.from(document.querySelectorAll('[data-testid^="widget-msg-"]'))
      .some((el) => el.textContent?.includes('Vou verificar')),
  { timeout: 5_000 },
);
await visitor.screenshot({ path: `${SHOTS}/05-visitor-receives.png` });
log('   ✅ resposta apareceu no widget sem refresh');

log('6. resolver no admin → widget recebe evento');
await admin.click('[data-testid="resolve-btn"]');
await visitor.waitForTimeout(1000);
await visitor.screenshot({ path: `${SHOTS}/06-after-resolve.png` });

log('---');
log(`errors: ${errors.length}`);
errors.forEach((e) => log(`  ✗ ${e}`));

await browser.close();
if (errors.length > 0) process.exit(2);
log('🎉 webchat smoke OK');
