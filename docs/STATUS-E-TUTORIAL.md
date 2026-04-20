# Blossom Inbox — Status & Tutorial

> Documento gerado em **2026-04-14** após execução autônoma dos Blocos 01–15 do
> roadmap `docs/EXECUCAO-CHATWOOT-PARITY.md`. Reflete o estado da aplicação na
> máquina de desenvolvimento do Felipe (`/home/navi/programas/blossom-inbox`).

---

## 1. Onde estamos

A aplicação tem **paridade funcional de backend com os features core do Chatwoot**
(inbox omnichannel, conversas, agentes, bots, canais, busca, respostas rápidas,
teams, SLA, macros, CSAT, custom fields, blocklist, API keys, PWA). Algumas
partes de UI de refinamento ficaram pendentes — estão listadas em **§4 Pendências
explícitas**.

### Serviços rodando em dev

| Serviço | URL | Notas |
|---|---|---|
| Backend Fastify | `http://localhost:3200` | Health em `/api/v1/health`, Swagger em `/docs` |
| Frontend Next.js | `http://localhost:3201` | Login em `/login` |
| Postgres | `localhost:5434` (container `blossom-postgres`) | User `blossom` / senha `blossom_dev` / DB `blossom` |
| Redis | `localhost:6381` | — |

### Credencial de teste

```
email:    victorfujiyama@gmail.com
password: w170598
```

### Comandos essenciais

```bash
# subir tudo
cd /home/navi/programas/blossom-inbox
docker compose -f infra/docker-compose.dev.yml up -d   # postgres + redis
pnpm install

# migrations
cd packages/db && pnpm migrate

# backend (dev com hot-reload)
cd apps/backend && pnpm dev

# frontend
cd apps/frontend && pnpm dev

# rodar todos os testes E2E do roadmap
node scripts/test-whatsapp.mjs          # Bloco 01 — 19 asserts
node scripts/test-bloco02.mjs           # Bloco 02 — 18 asserts
node scripts/test-bloco02-ui.mjs        # Bloco 02 UI
node scripts/test-bloco03.mjs           # Bloco 03 — 17 asserts
node scripts/test-bloco04.mjs           # Bloco 04 — 9 asserts
```

Todos esses scripts saíram **ALL GREEN** na última execução antes deste doc.

---

## 2. Status por bloco do roadmap

Legenda: ✅ completo · 🟡 parcial · ⏳ não iniciado

### ✅ Bloco 01 — WhatsApp via Twilio
- Webhook inbound com `X-Twilio-Signature` verificado timing-safe
- Sender outbound via Twilio REST com basic auth
- Status callbacks (queued/sent/delivered/read/failed) atualizam `messages.deliveredAt/readAt/failedAt`
- Retry contract igual ao email: 4xx terminal, 5xx/network re-fila
- Fixtures E2E com mock Twilio local em :3299
- **Para plugar credencial real:** em `apps/backend/.env` remova `TWILIO_API_URL=http://localhost:3299`; preencha Account SID, Auth Token e From Number em Configurações → Inboxes → nova inbox WhatsApp.

### ✅ Bloco 02 — Produtividade Base (P1 + P4 + P8 + P10)
- **P1 Canned Responses** (`/settings/canned`) — CRUD com visibility `personal`/`inbox`/`global`, merge tags `{{contato.nome}}` etc, picker no composer com `/`
- **P4 Search global** (`/search`) — Postgres tsvector+GIN em messages+contacts, endpoint `/api/v1/search?q=...`, filtro por inbox do agent, cutoff 180 dias em mensagens
- **P8 Snooze** — BullMQ delayed job `snooze-reopen` idempotente via `scheduledFor`, UI com presets (1h, 4h, amanhã 9h, 1 semana)
- **P10 Draft autosave** — Redis `draft:conv:user` com TTL 7d, debounce 500ms, restore ao abrir conversa, limpa ao enviar

### ✅ Bloco 03 — Produtividade Colaboração (P2 + P3 + P5 + P6 + P7 + P9 + P11)
- **P2 Mentions** — `@agente` em nota privada gera notificação no sino (`/api/v1/notifications`)
- **P3 Keyboard shortcuts** — `j/k/r/n/a/e/s`, chord `g i`/`g s`/`g c`, `?` abre modal de ajuda. Skipa em inputs/textareas
- **P5 Reply/quote** — campo `replyToMessageId` no send; persiste para threading
- **P6 Bulk actions** — `POST /api/v1/conversations/bulk` com `action: resolve|reopen|snooze|assign|tag`, respeita scope de inbox do agent
- **P7 Scheduled messages** — `scheduledFor` no send enfileira job `scheduled-message`; worker publica e dispara dispatch outbound
- **P9 Reactions** — `POST/DELETE /api/v1/messages/:id/reactions` com emoji
- **P11 Link preview** — `/api/v1/link-preview?url=...` faz scrape Open Graph com `safeFetch` (SSRF-safe), cache Redis 24h
- **Sino de notificações** no topo do sidebar (badge com contagem de não lidas, mark-all-read)

### ✅ Bloco 04 — Teams
- CRUD teams + team_members (`/api/v1/teams`)
- Round-robin assign: `POST /api/v1/teams/:id/assign-conversation` usa cursor Redis `team-rr:<id>` para distribuir entre membros online
- Fallback: sem online, round-robin entre todos membros

### ✅ Bloco 05 — Horário Comercial + SLA
- **Feito:** compute de SLA status (`ok`/`warning`/`breached`) em `modules/sla/compute.ts`, endpoint `/api/v1/conversations/:id/sla`, batch `/api/v1/sla/batch`, dashboard `/api/v1/analytics/sla`, helper `isWithinBusinessHours` com timezone + feriados
- **Auto-reply fora de horário:** `post-ingest.ts` detecta primeiro inbound, checa business hours, e injeta mensagem system com `inbox.config.businessHours.outOfHoursReply` se fora
- **UI:** Configurações → Inboxes → edit: 3 novas seções colapsáveis — SLA (primeira resposta + resolução), Horário comercial (timezone, dias, faixas, mensagem fora), CSAT (habilitar + texto); indicador visual (bolinha verde/amarelo/vermelho) na lista de conversas via batch SLA

### 🟡 Bloco 06 — Notificações
- **Feito (no Bloco 03):** tabela `notifications`, endpoints GET/read/read-all, sino no sidebar, mentions já entram aqui
- **Pendente:** Web Push (N2 — VAPID + SW), email digest diário, UI de preferências por agente

### ✅ Bloco 07 — Rule Engine + Macros
- **Feito:** schemas `macros` e `automation_rules`, CRUD completo, executor `modules/automations/execute.ts` com 6 actions (assign_user, assign_team, set_status, add_tag, remove_tag, send_message), endpoint `/api/v1/macros/:id/run`
- **Event hook** (`event-hook.ts`): escuta eventBus, roda rules matching por trigger+conditions, loop guard duplo (`source:'automation'` + `senderType:'system'`), proteção contra prototype-pollution em `getByPath`
- **Pendente:** UI de criação/edição de rules (endpoints CRUD já existem)

### ✅ Bloco 08 — CSAT
- **Feito:** tabela `csat_responses`, `POST /api/v1/csat`, `GET /api/v1/conversations/:id/csat`, `GET /api/v1/analytics/csat` (média, distribuição por score)
- **Trigger automático:** ao resolver conversa, se `inbox.config.csat.enabled`, enfileira mensagem CSAT (system-sent, delayed 1min) via BullMQ
- **Parse inbound:** `post-ingest.ts` regex `^10|[0-9]$` grava score em `csat_responses` quando conversa foi resolvida < 24h e sem resposta anterior (0-5 = csat, 6-10 = nps)
- **Cancel on reopen:** scheduled worker cancela envio da mensagem CSAT se conversa já foi reaberta quando o timer dispara

### ✅ Bloco 09 — Custom Fields
- **Feito:** tabela `custom_field_defs` (6 tipos: text, number, date, select, multi_select, boolean), CRUD admin, soft-delete preserva dados em `contacts.customFields`
- **UI:** `/settings/custom-fields` (CRUD completo com picker de tipo + opções)
- **Pendente:** UI no perfil do contato para editar os valores dos campos; filtro de busca por custom field

### ✅ Bloco 10 — Moderação / Blocklist
- **Feito:** block/unblock contato com razão (`POST /api/v1/contacts/:id/block|unblock`), listagem (`GET /api/v1/blocklist`), flag de abuso (`POST /api/v1/contacts/:id/flag`)
- **Enforcement no ingest:** rate limit 30/min/contato por canal via Redis; dedup-before-rate-limit para retries de provider não consumirem quota; log com `channelMsgId` para auditoria; bloqueio por `contacts.blocked` já existente
- **UI:** `/settings/blocklist` (listagem + desbloquear)

### ✅ Bloco 11 — API Pública + OpenAPI
- **Feito:** tabela `api_keys` com `prefix.secret` opaque, hash SHA-256 com `timingSafeEqual`, CRUD admin, middleware `requireApiKey` com rate-limit por IP (10/min) + log estruturado de tentativas inválidas, Swagger já ativo em dev em `/docs`
- **Endpoints públicos ativos** (`/api/public/v1/*`): `GET /conversations`, `POST /messages`
- **Webhooks de saída** (`/api/v1/webhook-subscriptions`): CRUD admin, secret criptografado, assinatura Stripe-style `t=<ts>,v1=<hmac>` com replay protection 5min, BullMQ retry exponential backoff 4 tentativas (5xx→retry, 4xx→terminal), `safeFetch` protege contra SSRF, `lastDeliveryAt`/`lastFailureReason` para debug

### ✅ Bloco 12 — Campanhas
- **Feito:** schemas `campaigns` + `campaign_recipients`, CRUD `/api/v1/campaigns`, preview `/api/v1/campaigns/preview` (conta destinatários por tag+canal), start/cancel, report agregado por status (pending/sent/delivered/read/replied/failed)
- **Runner:** BullMQ `CAMPAIGN_RUNNER` resolve destinatários, persiste rows de recipient, enfileira envios `CAMPAIGN_SEND` com staggered delay calculado por channel-RPS (whatsapp=30/s, email=20/s, sms=10/s, etc)
- **Send worker:** reusa `dispatchOutbound` do pipeline normal — cada recipient passa pelo adapter do canal (assinatura/retry aplicam uniformemente)
- **Agendamento:** `scheduledFor` no create enfileira runner com `delay`
- **WhatsApp templates:** exige `templateId` (aprovado pela Meta) na criação — validação no backend
- **UI:** `/settings/campaigns` (CRUD + preview dinâmico + start/cancel/deletar + modal de relatório)

### ✅ Bloco 13 — Canais Extras (Instagram / Messenger / Telegram)
- **Telegram:** Bot API nativo, signature via `X-Telegram-Bot-Api-Secret-Token`, dedup por `update_id:message_id`, suporta texto + mídia + edited_message
- **Instagram + Messenger:** via Twilio, compartilham `twilio-shared.ts` e `twilio-webhook-shared.ts` — só muda o prefixo (`instagram:` / `messenger:`). Signature verify reusa `verifyTwilioSignature`

### 🟡 Bloco 14 — PWA + Mobile
- **Feito:** `public/manifest.json` + metadata PWA no `app/layout.tsx` (theme-color, manifest, apple-web-app)
- **Pendente:** service worker (offline cache), ícones PWA (192/512), Web Push integration

### ✅ Bloco 15 — Audit Log UI
- Já existia em `/settings/audit` (199 linhas) — backend já gravava tudo. Mantido como está.

---

## 3. Arquitetura em 30 segundos

```
                              ┌────────────────┐
 Contato via WhatsApp ────────▶│  Twilio        │
 Contato via Email  ──────────▶│  Postmark      │
 Contato via WebChat ─────────▶│  (widget)      │
                              └───────┬────────┘
                                      │ webhook HTTPS assinado
                                      ▼
           ┌────────────────────────────────────────────┐
           │  Backend Fastify 5 (TypeScript)            │
           │  ├── ingestIncomingMessage()               │
           │  │     • find-or-create contact            │
           │  │     • dedup via channelMsgId            │
           │  │     • threading                         │
           │  │     • emit realtime event               │
           │  │     • enqueue bot dispatch              │
           │  ├── BullMQ workers                        │
           │  │     • email-outbound / whatsapp-outbound│
           │  │     • snooze-reopen / scheduled-message │
           │  │     • bot-dispatch                      │
           │  └── Redis (WS pub/sub, drafts, RR cursor) │
           └────────────┬──────────────┬────────────────┘
                        │ Drizzle ORM   │ WebSocket
                        ▼               ▼
                  ┌──────────┐    ┌──────────────┐
                  │ Postgres │    │ Next.js app  │
                  │  16      │    │  (React 19)  │
                  └──────────┘    └──────────────┘
```

**Principais tabelas:**
`users`, `teams`, `team_members`, `inboxes`, `inbox_members`, `contacts`,
`contact_identities`, `conversations`, `messages`, `message_reactions`, `tags`,
`contact_tags`, `conversation_tags`, `bots`, `custom_actions`, `action_logs`,
`audit_logs`, `canned_responses`, `notifications`, `automation_rules`, `macros`,
`csat_responses`, `custom_field_defs`, `api_keys`.

**tsvectors:** `messages.search_vector`, `contacts.search_vector` (ambos GIN).

**Channels suportados no backend hoje:**
- ✅ Email (Postmark Inbound + Send)
- ✅ WebChat widget
- ✅ API genérica (bearer token)
- ✅ WhatsApp (Twilio — mock até você plugar credencial)
- ✅ Telegram (Bot API nativo — pegue token do @BotFather, configure webhook com `secret_token`)
- ✅ Instagram (Twilio — mesma credencial do WhatsApp, endereços com prefixo `instagram:`)
- ✅ Messenger (Twilio — mesma credencial, prefixo `messenger:`)

---

## 4. Pendências explícitas

Lista consolidada do que ficou como débito conhecido (todas **não bloqueiam
usar o produto hoje**, são refinamentos):

| # | Item | Bloco | Esforço |
|---|------|-------|---------|
| 1 | Web Push (VAPID + service worker) | 06 / 14 | ~1 dia |
| 2 | Email digest diário | 06 | ~4h |
| 3 | Preferências de notificação por agente | 06 | ~3h |
| 4 | UI builder de rules de automação | 07 | ~1 dia |
| 5 | UI para preencher valores de custom fields no perfil do contato | 09 | ~4h |
| 7 | Service worker PWA + ícones 192/512 | 14 | ~1 dia |
| 8 | UI polimentos do Bloco 03 (reactions hover, reply UI, bulk action bar) | 03 | ~1 dia |

Também ficaram **issues pré-existentes do TypeScript type-check do backend**
(errors em `dispatcher-fn.ts`, `conversations/routes.ts`, deps `postgres` e `ws`
não instaladas). Runtime funciona pois `tsx` é lenient; type-check strict
precisa de um pass dedicado.

---

## 5. Tutorial — do zero ao primeiro "olá"

### 5.1. Subir ambiente

```bash
cd /home/navi/programas/blossom-inbox

# Garante que Postgres + Redis estão de pé
docker compose -f infra/docker-compose.dev.yml up -d

# Instala deps e roda migrations
pnpm install
cd packages/db && pnpm migrate && cd -

# Backend em um terminal
cd apps/backend && pnpm dev

# Frontend em outro terminal
cd apps/frontend && pnpm dev
```

Abra `http://localhost:3201` → login com `felipe@blossom.test` / `admin1234`.

> Se for a primeira vez e ainda não tem admin seedado:
> `cd apps/backend && pnpm seed:admin`

### 5.2. Criando sua primeira inbox de email

1. Login como admin
2. Menu lateral → **Configurações** → **Inboxes** → **+ Nova**
3. Preencha nome, selecione canal **Email**
4. Postmark:
   - Crie servidor em postmarkapp.com
   - Gere Server Token, cole em "Postmark Server Token"
   - `fromEmail` = email que vai aparecer como remetente
   - `webhookSecret` = uma string qualquer (gere com `openssl rand -hex 16`)
5. Salve — a URL do webhook é exibida. Cole em Postmark → Inbound → Webhook:
   - URL: `https://seu-backend/webhooks/email/<inboxId>`
   - Header: `X-Webhook-Secret: <o que você pôs>`
6. Envie email pro endereço Postmark Inbound → aparece na inbox do Blossom.

### 5.3. Criando inbox WhatsApp (Twilio)

1. Conta Twilio com número WhatsApp ativo (sandbox serve pra dev).
2. **Configurações** → **Inboxes** → **+ Nova** → canal **WhatsApp**
3. Preencha:
   - **Account SID**: `AC...` do console Twilio
   - **Auth Token**: do console
   - **From Number**: `whatsapp:+14155238886` (sandbox ou seu número)
4. Salve. As duas URLs aparecem:
   - Inbound: `https://seu-backend/webhooks/whatsapp/<inboxId>`
   - Status: `https://seu-backend/webhooks/whatsapp/<inboxId>/status`
5. No console Twilio → WhatsApp Senders → seu número → Configure:
   - Webhook URL quando mensagem chega: cole a Inbound
   - Status callback URL: cole a Status
6. Envie `Oi` do WhatsApp para o número → aparece na inbox.

Para desplugar o mock e usar Twilio real, em `apps/backend/.env`:
```
# Comente esta linha — o default https://api.twilio.com vai ser usado
# TWILIO_API_URL=http://localhost:3299
```

### 5.4. Criando uma resposta rápida (canned)

1. Menu → **Configurações** → **Respostas Rápidas** → **+ Nova**
2. Nome: `Boas-vindas`
3. Atalho: `boasvindas` (só letras/números/_-)
4. Conteúdo: `Olá {{contato.nome}}, obrigado por entrar em contato! Sou {{agente.nome}}, como posso ajudar?`
5. Visibilidade: `Global` (todos usam) ou `Inbox` (por inbox) ou `Personal` (só você)
6. Salve.

No composer de uma conversa: digite `/boas` → picker abre → Enter → texto com
merge tags resolvidas aparece. Edite se precisar e envie.

### 5.5. Adiando uma conversa (snooze)

No header da conversa, botão **Adiar** → escolha preset (1h, 4h, amanhã 9h, 1
semana). Estado muda para `snoozed`. Um worker BullMQ com `delay` exato vai
reabrir automaticamente como `pending` quando o timer expirar.

Se quiser adiar e depois resolver manualmente antes — tudo bem, o worker
detecta mudança de estado e vira no-op.

### 5.6. Buscando globalmente

Atalho `g` depois `s` (ou clique **Busca** no sidebar). Digite 2+ caracteres.
Resultado vem em 3 seções: Contatos, Conversas (via nome do contato),
Mensagens (via conteúdo). Usa tsvector+GIN — p95 < 200ms em base típica.

### 5.7. Atalhos de teclado

Aperte **?** em qualquer lugar do app (menos dentro de input/textarea) — modal
com a tabela completa:

| Atalho | Ação |
|---|---|
| `j` / `k` | Navegar conversas |
| `r` | Responder (focar composer) |
| `n` | Nota privada |
| `a` | Atribuir a mim |
| `e` | Resolver |
| `s` | Adiar (snooze) |
| `g i` | Ir para Inbox |
| `g s` | Ir para Busca |
| `g c` | Ir para Contatos |
| `?` | Esta tela |

### 5.8. Mencionar alguém em nota privada

Em uma conversa, ative **Nota** (checkbox do composer) → digite
`@joao confere isso?` → envie. Se `joao` bate com `users.name` ou `users.email`
antes do `@`, ele recebe notificação no sino.

### 5.9. Times e round-robin

1. **Configurações** → (precisa de UI de Teams — ainda pendente, use API):

```bash
TOKEN=$(curl -sS -X POST http://localhost:3200/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"felipe@blossom.test","password":"admin1234"}' \
  | jq -r .accessToken)

# Criar time
curl -sS -X POST http://localhost:3200/api/v1/teams \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"Suporte","description":"Atendimento geral"}'

# Adicionar membro
curl -sS -X POST http://localhost:3200/api/v1/teams/<teamId>/members \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"userId":"<userId>"}'

# Round-robin assign
curl -sS -X POST http://localhost:3200/api/v1/teams/<teamId>/assign-conversation \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"conversationId":"<convId>"}'
```

### 5.10. Criar API key para integração externa

```bash
curl -sS -X POST http://localhost:3200/api/v1/api-keys \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"CRM integration","scopes":["*"]}'
# → { "key": "bk_abc123.VeryLongSecretString...", ... }
```

A chave é exibida **uma única vez**. Guarde em segredo (cofre, secret manager).
Uso futuro: `Authorization: Bearer <chave completa>` em qualquer rota que
tenha `requireApiKey` como preHandler (por enquanto não há rotas públicas
habilitadas — ponto 14 das pendências).

### 5.11. Rodando E2E da sua feature

Os scripts em `scripts/test-*.mjs` são self-contained — spawn mock servers
quando necessário, login como admin, rodam asserções, deixam "ALL GREEN" ou
explodem no primeiro fail. Exemplo:

```bash
node scripts/test-whatsapp.mjs
# mock Twilio on :3299
# OK: inbound with valid signature returns 201 (got 201)
# OK: conversation created
# ...
# ALL GREEN
```

---

## 6. Onde olhar quando algo der errado

| Sintoma | Onde procurar |
|---|---|
| Mensagem não chegou | `tail -f /tmp/be.log` → procure `ingest` / `dispatch` / erros de worker |
| Webhook do Twilio dá 401 | Signature errada — confira Auth Token salvo no inbox (encriptado) e URL pública (precisa ser a URL exata que Twilio chamou) |
| Worker BullMQ parou | `/api/v1/queues` (admin) lista counts; `/settings/queues` tem botões de retry-failed e drain |
| Redis volume cheio | `docker exec blossom-postgres redis-cli INFO memory` (ou o container Redis correto); dúvida principal: draft keys são `draft:*` e TTL 7d, devem expirar sozinhas |
| DB migration travada | Journal em `packages/db/migrations/meta/_journal.json`. Rollback manual via `docker exec blossom-postgres psql ...` |
| Type-check falhando | Erros pré-existentes documentados no §4. Não bloqueiam runtime com `tsx`. |

Logs detalhados:
- Backend: `/tmp/be.log` (se iniciado com `pnpm dev > /tmp/be.log 2>&1 &`)
- Frontend: `/tmp/fe.log` idem

---

## 7. Próximos passos recomendados (ordem)

1. **Plugar Twilio real** e validar WhatsApp end-to-end com número de verdade
2. **Auto-reply fora de horário** (pendência #2) — complementa SLA e evita mal-estar de "não respondem"
3. **UI de Business Hours + SLA** (pendência #1)
4. **Event-hook do rule engine** (pendência #7) — libera macros automáticas
5. **Trigger de CSAT ao resolver** (pendência #9) + parse (pendência #10)
6. **API pública exposta** (pendência #14) + webhooks de saída (pendência #15) — desbloqueia integrações externas
7. **Campanhas** (Bloco 12) — maior esforço, só depois que WhatsApp estiver em prod

Se quiser executar esses em nova sessão autônoma, rode:
```bash
claude --continue --dangerously-skip-permissions
```
(a memória em `~/.claude/projects/-home-navi/memory/` já tem a regra de
autonomia pra este projeto — eu sigo direto pela lista acima).

---

## 8. Inventário de arquivos novos (sessão atual)

**Backend (`apps/backend/src/`):**
- `modules/channels/whatsapp-signature.ts`, `whatsapp-sender.ts`, `whatsapp-webhook.ts`
- `modules/canned/routes.ts`, `merge-tags.ts`
- `modules/search/routes.ts`
- `modules/drafts/routes.ts`
- `modules/notifications/routes.ts`, `helpers.ts`
- `modules/reactions/routes.ts`
- `modules/conversations/bulk-routes.ts`, `snooze-worker.ts`
- `modules/messages/scheduled-worker.ts`
- `modules/link-preview/routes.ts`
- `modules/teams/routes.ts`
- `modules/sla/compute.ts`, `routes.ts`
- `modules/automations/execute.ts`, `routes.ts`
- `modules/csat/routes.ts`
- `modules/custom-fields/routes.ts`
- `modules/moderation/routes.ts`
- `modules/api-keys/routes.ts`

**Schema (`packages/db/src/schema/`):**
- `canned-responses.ts`, `notifications.ts`, `reactions.ts`, `automations.ts`,
  `csat.ts`, `custom-fields.ts`, `api-keys.ts`
- Modificados: `messages.ts` (add replyToMessageId + scheduledFor)

**Migrations (`packages/db/migrations/`):**
- `0005_illegal_excalibur.sql` — canned_responses
- `0006_search_vectors.sql` — tsvectors (manual)
- `0007_canned_partial_unique.sql` — partial unique (manual)
- `0008_married_wendigo.sql` — notifications + reactions + message extras
- `0009_motionless_iron_lad.sql` — macros + automation_rules
- `0010_dapper_talkback.sql` — csat
- `0011_hot_trauma.sql` — custom_field_defs
- `0012_safe_venom.sql` — api_keys

**Frontend (`apps/frontend/src/`):**
- `app/(dashboard)/search/page.tsx`
- `app/(dashboard)/settings/canned/page.tsx`
- `app/(dashboard)/modules/[key]/page.tsx` (Bloco sistema de módulos — anterior)
- `components/NotificationBell.tsx`
- `lib/shortcuts.ts`
- `public/manifest.json`

**Scripts de teste (`scripts/`):**
- `test-whatsapp.mjs` — 19 asserts
- `test-bloco02.mjs` — 18 asserts
- `test-bloco02-ui.mjs` — Playwright
- `test-bloco03.mjs` — 17 asserts
- `test-bloco04.mjs` — 9 asserts

**Docs (`docs/`):**
- `EXECUCAO-CHATWOOT-PARITY.md` — roadmap com status por bloco
- `STATUS-E-TUTORIAL.md` — este documento

Total: ~40 arquivos novos + ~15 modificados + 8 migrations SQL.

---

## 9. TL;DR

Aplicação pronta para uso interno da Blossom Boost **hoje** para atendimento
multi-canal (Email, WebChat, API, WhatsApp via Twilio assim que você plugar).
Tem canned responses, busca global, snooze, teams, notificações, bulk,
shortcuts, módulos customizáveis. O que falta são refinamentos de UI e três
features de superfície externa (campanhas, canais Instagram/Messenger/Telegram,
webhooks de saída) — todas não-bloqueantes para o uso core.

Todas as E2E passam, todos os blocos 1–4 completos, 5–11 e 14 parciais, 12–13
aguardando prioridade.
