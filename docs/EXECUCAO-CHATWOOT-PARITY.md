# Execução — Chatwoot Parity

Plano de execução sequenciado pra atingir paridade com Chatwoot no uso interno da
Blossom Boost. **Fonte da verdade do *o quê*:** `PLANO-TECNICO.md` §2. Este doc
cobre *em que ordem* e *quando um bloco está pronto*.

## Princípios

- **1 bloco = 1 PR revisável** (ou sequência curta). Depois de cada bloco: senior
  review com o plano técnico em mãos + E2E (curl/Playwright) onde fizer sentido.
- **Acceptance antes de seguir:** um bloco só "fecha" quando os critérios
  listados passam. Não começa o próximo com crítico aberto.
- **Não reabrir blocos:** fixes pequenos viram patch logo após. Refactor vira
  bloco próprio.
- **Dependências explícitas:** não pular ordem sem mover o critério afetado pra
  depois (ex.: SLA sem Teams trava relatório por time).
- **Dummy/mock first quando crédito externo trava:** WhatsApp entra com
  fixtures do Twilio, integração real quando Felipe plugar credencial.

## Convenção de estimativa

Dias úteis *ideais* (1 dev focado). Multiplicar por 1.3 na prática.

---

## Bloco 01 — WhatsApp via Twilio (C1, crítico) ✅ CONCLUÍDO

**Por quê primeiro:** marcado "crítico" no plano. É o canal que destrava uso
interno de verdade. Arquitetura de channel adapter já existe (email/webchat/api),
isso é o 4º adapter.

**Itens:**
- Inbound webhook Twilio (POST form-urlencoded) com verificação de assinatura
  `X-Twilio-Signature` (HMAC SHA1 na URL + params)
- Outbound send (text + mídia) via Twilio REST
- Status callbacks (`queued`/`sent`/`delivered`/`read`/`failed`) mapeados pra
  `deliveredAt`/`readAt`/`failedAt`
- Mídia: download do Twilio → upload pro R2 (ou storage local dev) → re-expose
  signed URL
- Template messages aprovados Meta (só placeholder agora — usado em campanhas)

**Critério de aceite:**
- Fixture de payload inbound real do Twilio entra via `/channels/whatsapp/webhook`,
  cria contato/conversa/mensagem, assinatura verificada
- Assinatura inválida → 401, nunca 200
- Mensagem outbound → mock Twilio recebe payload correto; status callbacks
  atualizam `deliveredAt`
- `senior-code-reviewer` aprovado com foco em **signature verification** e
  **SSRF na mídia** (safe-fetch já existe — reutilizar)
- E2E: Playwright cria conversa WhatsApp via fixture inbound, atendente responde,
  mock confirma delivery

**Dependências:** nenhuma (canais já existentes como referência)

**Estimativa:** 3-4 dias

---

## Bloco 02 — Produtividade Base (P1, P4, P8, P10) ✅ CONCLUÍDO

**Por quê agora:** o inbox sem canned responses + search + snooge UI "parece
beta". São as features que o atendente toca 50× por dia.

**Itens:**
- **P1 Canned Responses**: CRUD, visibilidade (pessoal / team / inbox-wide),
  merge tags (`{{contato.nome}}`, `{{agente.nome}}`, `{{conversa.id}}`), UI com
  `/` no composer abrindo picker
- **P4 Search Global**: `tsvector` em messages + conversations + contacts,
  trigger de update, endpoint `/api/v1/search?q=...` com filtros, página `/search`
- **P8 Conversation Snooge**: BullMQ delayed job reabrindo conversa `snoozed →
  pending` no `snoozedUntil`; botão no header da conversa com presets (1h, 4h,
  amanhã 9h, customizado)
- **P10 Draft autosave**: salvar rascunho por `(conversationId, userId)` em
  Redis com TTL 7d; restaurar ao abrir conversa

**Critério de aceite:**
- `/boasvindas` no composer insere texto com merge tags resolvidas
- Search encontra mensagem por trecho, conversa por título, contato por nome
  (p95 < 200ms em base de 10k msgs seed)
- Snooze com `snoozedUntil` no passado dispara reopen via worker
- Recarregar página preserva rascunho digitado
- Senior review + E2E

**Dependências:** nenhuma

**Estimativa:** 4-5 dias

---

## Bloco 03 — Produtividade Colaboração (P2, P3, P5, P6, P9, P7, P11) ✅ CONCLUÍDO

**Por quê:** completa §2.11. Depois disso o composer/lista de conversas fica
"chatwoot-level".

**Itens:**
- **P2 Mentions** em private notes (`@agente` com picker), gera notification
- **P3 Keyboard shortcuts**: `j/k` navegar, `r` reply, `n` note, `a` assign,
  `e` resolve, `s` snooze, `g i` inbox, `?` modal de ajuda
- **P5 Reply/quote**: citar mensagem anterior (UI + passa header `In-Reply-To` em
  canais que suportam — email já faz)
- **P6 Bulk actions** na lista: selecionar N conversas → tag/assign/resolve/snooze
- **P7 Scheduled messages**: BullMQ delayed job; UI de agendamento no composer
- **P9 Message reactions** internas (emoji picker no hover da mensagem; storage
  em `message_reactions`)
- **P11 Link preview**: Open Graph scrape via safe-fetch, cache 24h em Redis

**Critério de aceite:**
- Mention gera entry em `notifications` (tabela nova) + push no WS pro mencionado
- Shortcuts funcionam e não conflitam com input fields
- Bulk selecionando 50 conversas e resolvendo: 1 request, resposta < 1s
- Senior review + E2E

**Dependências:** Bloco 02 (notifications table será usada também por P2)

**Estimativa:** 5-6 dias

---

## Bloco 04 — Teams (§2.12) ✅ CONCLUÍDO

**Por quê aqui:** pré-requisito pra SLA por time, macros com "assign ao team",
round-robin, team canned responses, relatórios por time.

**Itens:**
- Schema: `teams`, `team_members`, `team_inboxes` (inbox pode ter N teams)
- **T1 Teams** CRUD
- **T2 Assign pra team**: conversa fica em estado "pool do team X", qualquer
  membro pega (claim) ou recebe via round-robin
- **T3 Round-robin**: ao assign a team com `mode=roundrobin`, cursor em Redis
  rotaciona agente online do team
- **T5 Team-specific canned responses**: visibility=`team:<id>` em P1

**Critério de aceite:**
- Conversa assigned a team sem agente: aparece em "Team pool"
- Round-robin distribui 10 conversas entre 3 agentes online: 4/3/3 (ou 3/3/4)
- Agente offline é pulado
- Reopen respeita team anterior
- Senior review + E2E

**Dependências:** Bloco 02 (P1 precisa de visibility por team)

**Estimativa:** 3-4 dias

---

## Bloco 05 — Horário Comercial + SLA (§2.13) ✅ (backend + auto-reply no ingest + UI config por inbox + indicador visual na lista)

**Itens:**
- **S1** `business_hours` por inbox: dias, faixas, timezone, feriados
- **S2** Auto-reply fora de horário (mensagem template configurável)
- **S3** SLA por inbox/priority: `first_response_target_seconds`,
  `resolution_target_seconds`
- **S4** Indicador visual na conversa (verde/amarelo/vermelho) computado no
  backend no read (não em cron, não em trigger)
- **S5** Relatório SLA no dashboard: cumprimento por inbox / por team / por agente

**Critério de aceite:**
- Mensagem recebida 22h (fora do horário) → auto-reply disparado 1×
- Conversa sem primeira resposta há 80% do SLA: cor amarela; >100%: vermelha
- Relatório SLA com seed determinístico fecha número esperado

**Dependências:** Bloco 04 (relatório por team)

**Estimativa:** 3-4 dias

---

## Bloco 06 — Notificações (§2.15) ✅ PARCIAL (sino+mentions feitos; push/email digest/prefs pendentes)

**Itens:**
- Schema `notifications` (já tocado no Bloco 03 pra mentions — aqui consolida)
- **N1 In-app sino** no header: lista paginada de notificações não lidas, mark
  as read, jump to source
- **N4 Email digest** diário (BullMQ cron): "você tem X conversas não
  respondidas", opt-in
- **N5 Preferências por agente**: quais eventos (message.created, mention,
  assign, sla.breached) geram notificação e por qual canal (in-app / email /
  push)
- **N2 Web Push** — **decidir** (VAPID + service worker). Se Felipe ok, entra
  como subtarefa. Se não, fica anotado como débito e pulamos pra bloco 07.

**Critério de aceite:**
- Sino mostra badge com unread count, clicar abre dropdown
- Email digest job roda e envia email mock em ambiente de teste
- Preferências salvas por agente respeitadas
- Senior review

**Dependências:** Bloco 03 (mentions já usa a tabela)

**Estimativa:** 3-4 dias (+1 se N2 entrar agora)

---

## Bloco 07 — Rule Engine + Macros (§2.14) ✅ (macros + CRUD rules + event-hook listening + loop guards; UI de builder pendente)

**Por quê aqui:** precisa de teams (assign), SLA (trigger de breach), horário
comercial (trigger fora horário) pra ter value real.

**Itens:**
- **AU1** Rule engine: schema JSON declarativo `{ trigger, conditions, actions }`
- **AU2** Triggers: `message.created`, `conversation.created`, `conversation.assigned`,
  `conversation.no_response_for` (delayed job), `tag.added`, `module.event.<name>`
- **AU3** Actions: assign, reassign (agente/team), change status, apply tag,
  send message (template), call webhook, run macro
- **AU4** Macros: ação composta, disparo manual do atendente via dropdown na
  conversa

**Critério de aceite:**
- Regra "pending > 30min + tag=urgente → assign supervisor" roda via job
  delayed, re-enfileira se condição ainda vale
- Macro "Pedido enviado" (tag + message + resolve) em 1 clique
- DSL validada por Zod; UI de criação com builder visual simples
- Senior review (atenção a loops infinitos de regra)

**Dependências:** Blocos 04 e 05

**Estimativa:** 5-6 dias

---

## Bloco 08 — CSAT (§2.16) ✅ (schema + API + dashboard + trigger on resolve + parse inbound + cancel on reopen)

**Itens:**
- **CS1** Ao resolver conversa → dispara mensagem template "Como foi seu
  atendimento? 1-5"
- **CS2** Multi-canal (WhatsApp, email, webchat) — cada canal com formato
  nativo (quick replies no WA, link no email)
- **CS3** NPS opcional configurável por inbox
- **CS4** Dashboard CSAT: média por agente/inbox/período
- **CS5** Comentário qualitativo opcional após nota

**Critério de aceite:**
- Resolver conversa dispara job de CSAT com delay 1min
- Resposta do contato é parseada e persistida em `csat_responses`
- Dashboard agrega corretamente
- Senior review

**Dependências:** Bloco 01 (WhatsApp — pra testar multi-canal real)

**Estimativa:** 3-4 dias

---

## Bloco 09 — Campos Customizados de Contato (CT2) ✅ (schema + API + UI admin; UI de preenchimento no perfil pendente)

**Itens:**
- Schema: `custom_field_defs` (por tenant futuro — por ora global) + `contacts.customFields` JSONB
- UI: admin declara campos (texto, número, data, select, multi-select)
- Perfil do contato mostra campos na ordem definida, editáveis
- Busca filtra por custom field

**Critério de aceite:**
- Admin cria campo "CNPJ" (texto) → aparece no perfil, editável, buscável
- Remoção de campo preserva dados (soft-delete da def)

**Dependências:** nenhuma (pode paralelizar)

**Estimativa:** 2-3 dias

---

## Bloco 10 — Moderação / Blocklist (§2.17) ✅ (block/unblock + flag + rate-limit 30/min no ingest + dedup-before-rate + UI /settings/blocklist)

**Itens:**
- **M1 Blocklist** por tenant: `blocked_identities (channel, value)`
- **M2 Spam filter email** básico (SPF/DKIM via Postmark já ajuda; adicionar
  regras de assunto/remetente)
- **M3 Flag contato abusivo** (agente marca, supervisor revisa)
- **M4 Rate limit por contato**: N mensagens / janela → descarta com log

**Critério de aceite:**
- Mensagem de número bloqueado: descartada silenciosamente + audit log
- Rate limit testado com 20 msgs em 10s → 15ª em diante é dropped
- Senior review

**Dependências:** nenhuma

**Estimativa:** 2-3 dias

---

## Bloco 11 — API Pública + OpenAPI (§2.18) ✅ (API keys + middleware anti-bruteforce + endpoints /api/public/v1/* + webhooks outbound HMAC com retry)

**Por quê aqui:** agora que features core estão cobertas, a API pública expõe
tudo com superfície estável. Fazer antes causaria breaking changes.

**Itens:**
- **AP1** API Key auth: `api_keys` table, middleware `requireApiKey`, scopes
- **AP2** Endpoints públicos: CRUD contacts/conversations/messages/tags + send
  message programático
- **AP3** Outbound webhooks: `webhook_subscriptions` (tenant, events, url, secret),
  entrega via BullMQ com retry exponencial e HMAC signature (já temos helper)
- **AP4** Retry 5 tentativas, dead-letter após falha final
- **AP5** Swagger UI já existe em dev — promover pra rota pública `/docs/v1`
  com exemplos

**Critério de aceite:**
- API Key criado via admin UI, funciona em curl
- Webhook de saída entrega evento, verifica assinatura, retry em 5xx
- OpenAPI spec válido (swagger-parser)
- Senior review (auth bypass, leak de dados cross-tenant)

**Dependências:** todos os anteriores (superfície estável)

**Estimativa:** 4-5 dias

---

## Bloco 12 — Campanhas (§2.9) ✅ (schema + CRUD + preview + runner com throttle por canal + report + UI; WhatsApp exige templateId Meta)

**Itens:**
- **CP1** CRUD campanha: inbox, segmentação (tags), template
- **CP2** Envio em massa respeitando rate limit por canal (throttled BullMQ
  queue com `limiter`)
- **CP3** Relatório: entregue/lido/respondido/erro
- **CP4** Disparo agendado

**Critério de aceite:**
- Campanha com 500 contatos respeita 80 msgs/s Twilio
- Relatório fecha números com `deliveredAt`/`readAt`/`failedAt`
- WhatsApp usa **somente templates aprovados Meta** (validação no create)
- Senior review (bulk send sem validação = ban risk)

**Dependências:** Bloco 01 (WhatsApp) e Bloco 11 (templates como objeto de API)

**Estimativa:** 4-5 dias

---

## Bloco 13 — Canais Extras (C4, C5, C6) ✅ (Telegram nativo + Instagram + Messenger — todos via Twilio compartilhando twilio-shared.ts)

**Por quê por último:** WhatsApp cobre 80% do valor. Instagram/Messenger/Telegram
entram quando demanda real aparecer.

**Itens:**
- **C4/C5** Instagram DM + Messenger via Twilio (mesma plumbing de C1)
- **C6** Telegram via Bot API nativo (polling ou webhook)

**Critério de aceite:**
- Inbound/outbound cada canal, fixture-test como em C1
- Senior review

**Dependências:** Bloco 01

**Estimativa:** 3-4 dias (os 3 juntos, reutilizando adapter pattern)

---

## Bloco 14 — PWA + Mobile (§2.19) ✅ PARCIAL (manifest + metadata; service worker e push pendentes)

**Itens:**
- **MB1** Responsive (auditoria + fixes no Tailwind — inbox, conversa, settings)
- **MB2** PWA: manifest, service worker, offline básico (cache shell + última
  conversa)
- **MB3** Web Push mobile (casou com N2 se já entrou no Bloco 06)

**Critério de aceite:**
- Lighthouse PWA score > 90
- Instalável no Android/iOS, abre fora do browser

**Dependências:** Bloco 06 (push)

**Estimativa:** 3-4 dias

---

## Bloco 15 — Audit Log UI (§2.20) ✅ JÁ EXISTIA (UI admin em `/settings/audit` pré-existente — 199 linhas)

**Itens:**
- **AL1** Página admin com filtros (usuário, ação, entidade, período)
- **AL3** Export CSV (usar `csvEscape` já existente)
- **AL4** Retenção configurável: cron que apaga audits > N dias

**Critério de aceite:**
- Filtros funcionam com seed de 10k audits
- CSV gerado é importável no Excel sem injection
- Senior review

**Dependências:** nenhuma (backend já grava tudo)

**Estimativa:** 1-2 dias

---

## Resumo / Caminho crítico

```
01 WhatsApp ─┬─► 08 CSAT
             ├─► 12 Campanhas (também precisa 11)
             └─► 13 Canais extras

02 Produtividade Base ─► 03 Colab ─► 06 Notificações ─► 07 Rules
                              │
02, 03 ────────────────────────┴─► 04 Teams ─► 05 SLA ─► 07 Rules

Paralelizáveis (independentes): 09 Custom Fields, 10 Moderação, 15 Audit UI

11 API Pública ─► 12 Campanhas
                │
06 (com N2) ───┴─► 14 PWA
```

**Soma estimativa:** 48-62 dias úteis ideais ≈ 13-17 semanas com buffer 1.3×.
Bate com §22 do plano (Fase 3 sozinha = 8 semanas, e aqui estamos cobrindo
Fase 2 restante + Fase 3 completa).

## Definition of Done (por bloco)

- [ ] Schema + migration (se aplicável)
- [ ] Backend: rotas + validação Zod + testes unit quando lógica não-trivial
- [ ] Frontend: UI funcional + empty states + loading/error
- [ ] E2E relevante (curl pra backend-only, Playwright pra fluxo UI)
- [ ] Type-check limpo no módulo tocado
- [ ] Senior review aprovado (issues críticos fechados; médios viram tasks)
- [ ] Config nova documentada no `.env.example`
- [ ] Sem `TODO:` sem task associada

## O que NÃO entra nessa passada (pós-Chatwoot-parity)

- U1–U9 (§2.21): unificação cross-canal, enrichment, IA nativa, CRMs, ecommerce,
  WeChat, voice, co-browsing, AI Agent autônomo
- Multi-tenant real (provisioning §14 só foi scaffold)
- Billing / self-service signup
- White-label / tiers
- App nativo React Native

Esses vão pra Fase 4 conforme plano técnico §21.
