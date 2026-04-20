import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const SHOTS = resolve('tmp/screenshots/settings');
mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[settings] ${m}`);

log('seed (clean slate, keep admin)');
execSync(
  `docker exec blossom-postgres psql -U blossom -d blossom -c "
    DELETE FROM messages; DELETE FROM conversation_tags; DELETE FROM conversations;
    DELETE FROM contact_identities; DELETE FROM contact_tags; DELETE FROM contacts;
    DELETE FROM bots; DELETE FROM inbox_members; DELETE FROM inboxes;
    DELETE FROM tags; DELETE FROM users WHERE role='agent' OR role='supervisor';" > /dev/null`,
  { shell: '/bin/bash' },
);
execSync('docker exec blossom-redis redis-cli FLUSHDB > /dev/null', { shell: '/bin/bash' });

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

log('2. navegar para settings');
await page.click('a[href="/settings"]');
await page.waitForURL(/\/settings\/inboxes/);
await page.waitForSelector('[data-testid="settings-nav-inboxes"]');
await page.screenshot({ path: `${SHOTS}/01-settings-inboxes-empty.png` });

log('3. criar inbox via UI');
await page.click('[data-testid="inboxes-new-btn"]');
await page.waitForSelector('[data-testid="inbox-name-input"]');
await page.fill('[data-testid="inbox-name-input"]', 'Canal Teste UI');
// channelType=api é padrão
await page.fill('[data-testid="inbox-token-input"]', 'ui_token_123');
await page.screenshot({ path: `${SHOTS}/02-inbox-create-modal.png` });
await page.click('[data-testid="inbox-submit-btn"]');
await page.waitForSelector('[data-testid^="inbox-item-"]');
await page.screenshot({ path: `${SHOTS}/03-inbox-created.png` });
log('   ✅ inbox criado');

log('4. criar tag via UI');
await page.click('[data-testid="settings-nav-tags"]');
await page.waitForSelector('[data-testid="tags-new-btn"]');
await page.click('[data-testid="tags-new-btn"]');
await page.fill('[data-testid="tag-name-input"]', 'prioridade');
// color picker default OK
await page.screenshot({ path: `${SHOTS}/04-tag-create-modal.png` });
await page.click('[data-testid="tag-submit-btn"]');
await page.waitForSelector('[data-testid^="tag-item-"]');
await page.screenshot({ path: `${SHOTS}/05-tag-created.png` });
log('   ✅ tag criada');

log('5. criar atendente via UI');
await page.click('[data-testid="settings-nav-users"]');
await page.waitForSelector('[data-testid="users-new-btn"]');
await page.click('[data-testid="users-new-btn"]');
await page.fill('[data-testid="user-email-input"]', 'carla@blossom.test');
await page.fill('[data-testid="user-name-input"]', 'Carla UI');
// senha já vem gerada
await page.screenshot({ path: `${SHOTS}/06-user-create-modal.png` });
await page.click('[data-testid="user-submit-btn"]');
// Wait for list to reload with 2+ users
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid^="user-item-"]').length >= 2,
  { timeout: 5_000 },
);
// Password is revealed in a persistent modal — dismiss it.
await page.waitForSelector('[data-testid="user-revealed-password"]');
await page.screenshot({ path: `${SHOTS}/07a-password-revealed.png` });
await page.keyboard.press('Escape');
const userCount = await page.locator('[data-testid^="user-item-"]').count();
if (userCount < 2) throw new Error(`esperava 2 users (admin+Carla), veio ${userCount}`);
await page.screenshot({ path: `${SHOTS}/07-users-list.png` });
log(`   ✅ ${userCount} atendentes listados, senha revelada em modal persistente`);

log('6. criar bot via UI');
await page.click('[data-testid="settings-nav-bots"]');
await page.waitForSelector('[data-testid="bots-new-btn"]');
await page.click('[data-testid="bots-new-btn"]');
await page.fill('[data-testid="bot-name-input"]', 'BotUI');
await page.fill('[data-testid="bot-webhook-input"]', 'http://localhost:4100/');
// inbox auto-selecionado
await page.screenshot({ path: `${SHOTS}/08-bot-create-modal.png` });
await page.click('[data-testid="bot-submit-btn"]');
// Aguardar modal de secret revelado
await page.waitForSelector('[data-testid="bot-revealed-secret"]');
await page.screenshot({ path: `${SHOTS}/09-bot-secret-revealed.png` });
log('   ✅ bot criado e secret revelado (mascarado por default)');

// Fecha modal de secret
await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid^="bot-item-"]');
await page.screenshot({ path: `${SHOTS}/10-bot-list.png` });

log('7. volta em Inboxes e define bot padrão');
await page.click('[data-testid="settings-nav-inboxes"]');
await page.waitForSelector('[data-testid^="inbox-item-"]');
// Edit
await page.locator('[data-testid^="inbox-item-"]').first().locator('button').nth(1).click(); // edit icon (2nd button)
await page.waitForSelector('[data-testid="inbox-default-bot-select"]');
await page.selectOption('[data-testid="inbox-default-bot-select"]', { index: 1 });
await page.screenshot({ path: `${SHOTS}/11-inbox-edit-default-bot.png` });
await page.click('[data-testid="inbox-submit-btn"]');
log('   ✅ default bot atribuído');

log(`---`);
log(`console errors: ${errors.length}`);
errors.forEach((e) => log(`  ✗ ${e}`));

await browser.close();
if (errors.length > 0) process.exit(2);
log('🎉 settings UI smoke OK');
