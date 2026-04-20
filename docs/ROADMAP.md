# Blossom Inbox — Roadmap de Implementacao

**Data:** 20 de abril de 2026  
**Versao:** 1.0  
**Comparacao com:** Chatwoot v4.12.1

---

## Status Atual da Plataforma

| Item | Status |
|------|--------|
| Fase 1 — Bot Webhook (externo) | Completo |
| Fase 2A — Bot IA (OpenAI/Claude nativo) | Completo |
| Frontend pixel-perfect com Chatwoot | Maioria das telas |
| Total de paginas funcionais | 39 paginas |
| Paginas placeholder | 0 |

### O que ja funciona:

- **Inbox omnicanal:** WhatsApp (Twilio), Email, Telegram, Instagram DM, Messenger, WebChat, SMS, API
- **Conversas:** listagem, filtros, busca, atribuicao, labels, notas privadas, status (open/pending/resolved/snoozed)
- **Contatos:** listagem, filtros, campos customizaveis, merge, notas, historico, import/export
- **Bots externos:** webhook-based, HMAC auth, retry com backoff, fallback para humano
- **Bots IA nativos:** OpenAI/Claude, system prompt, handoff automatico por keywords, greeting message
- **Dashboard:** KPIs, volume diario, metricas por agente e inbox, export CSV
- **Campanhas:** disparo em massa, agendamento, relatorio
- **Settings completo:** conta, inboxes (com bot config), agentes, times, labels, atributos custom, respostas prontas, acoes custom, API keys, webhooks, filas, bloqueio, audit logs
- **Realtime:** WebSocket para mensagens e eventos de conversa
- **Seguranca:** JWT + refresh, RBAC (admin/supervisor/agent), HMAC webhooks, AES-256-GCM encryption, safeFetch anti-SSRF

---

## 1. Features do Chatwoot que Faltam

### 1.1 Automation — Prioridade ALTA

**O que e:** Regras automaticas que executam acoes quando eventos acontecem.

**Exemplos praticos:**
- "Quando uma conversa for criada no inbox WhatsApp, atribuir ao Time de Suporte"
- "Quando mensagem contiver 'urgente', adicionar label 'prioridade' e notificar supervisor"
- "Quando conversa ficar sem resposta por 1h, enviar mensagem automatica"

**Componentes necessarios:**

| Componente | Descricao |
|-----------|-----------|
| Triggers | message_created, conversation_created, conversation_updated |
| Condicoes | contem palavra, status = X, inbox = Y, label = Z, etc. |
| Acoes | atribuir agente/time, adicionar/remover label, enviar mensagem, mudar status, enviar webhook |
| Schema DB | tabela `automation_rules` (ja existe no schema, falta implementar a engine) |
| Engine | Event listener que avalia regras e executa acoes |
| Frontend | Tela de CRUD com builder visual de regras |

**Estimativa:** 3-5 dias

---

### 1.2 SLA (Service Level Agreement) — Prioridade MEDIA

**O que e:** Definir tempos maximos de resposta e resolucao, com alertas.

**Exemplos praticos:**
- "Primeira resposta em ate 5 minutos para inbox WhatsApp"
- "Resolucao em ate 4 horas para conversas com label 'urgente'"
- "Alerta amarelo com 80% do tempo, alerta vermelho quando estourar"

**Vantagem:** ja temos `firstResponseAt` e `waitingForAgentSince` no schema — a infra base existe.

**Componentes necessarios:**

| Componente | Descricao |
|-----------|-----------|
| Schema DB | tabela `sla_policies` com tempo de resposta/resolucao por inbox/prioridade |
| Engine | Job periodico que verifica conversas proximas de estourar SLA |
| Notificacoes | Alertas no painel + notificacao para supervisor |
| Dashboard | Indicadores de SLA no dashboard (% cumprido, tempo medio) |
| Frontend | Tela de CRUD de politicas SLA |

**Estimativa:** 2-3 dias

---

### 1.3 Security — Prioridade MEDIA

**O que e:** Configuracoes de seguranca da conta.

**Funcionalidades:**

| Feature | Descricao |
|---------|-----------|
| Password policy | Tamanho minimo, complexidade, expiracao |
| Session timeout | Tempo maximo de inatividade antes de deslogar |
| IP allowlist | Restringir acesso por IP (importante pra producao) |
| 2FA | Autenticacao em dois fatores (TOTP) — futuro |
| Login history | Historico de logins com IP e user-agent |

**Estimativa:** 2-3 dias (sem 2FA), +2 dias com 2FA

---

### 1.4 Macros — Prioridade MEDIA

**O que e:** Sequencias de acoes pre-definidas que o agente executa com um clique.

**Exemplos praticos:**
- "Escalar para supervisor" = atribuir time Supervisores + label 'escalado' + nota privada "Escalado por [agente]"
- "Encerrar com CSAT" = enviar mensagem de avaliacao + resolver conversa
- "Transferir para financeiro" = atribuir time Financeiro + nota privada com resumo

**Componentes necessarios:**

| Componente | Descricao |
|-----------|-----------|
| Schema DB | tabela `macros` (ja existe no schema Drizzle!) |
| API | CRUD de macros + endpoint de execucao |
| Frontend (settings) | Tela de CRUD com builder de sequencia de acoes |
| Frontend (inbox) | Botao/menu de macros no editor de mensagens |

**Estimativa:** 2-3 dias

---

### 1.5 Conversation Workflow — Prioridade BAIXA

**O que e:** Regras de distribuicao automatica de conversas.

**Funcionalidades:**

| Feature | Descricao |
|---------|-----------|
| Auto-assign | Atribuir conversa nova ao primeiro agente disponivel |
| Round-robin | Distribuir igualmente entre agentes do inbox |
| Load balancing | Atribuir ao agente com menos conversas ativas |
| Capacity limits | Limite maximo de conversas por agente |

**Estimativa:** 2-3 dias

---

### 1.6 Integrations — Prioridade BAIXA

**O que e:** Marketplace de integracoes com ferramentas externas.

**Nota:** Nosso sistema de webhooks + custom actions ja cobre a maioria dos casos de uso. Integracoes nativas (Slack, etc.) sao convenience features, nao bloqueadores.

**Estimativa:** Variavel por integracao (1-2 dias cada)

---

### 1.7 Custom Roles — Prioridade BAIXA

**O que e:** Roles personalizados alem de admin/supervisor/agent.

**Nota:** Para uso interno da holding, os 3 roles atuais sao suficientes. Custom roles se torna importante quando vendermos como SaaS e clientes quiserem granularidade.

**Estimativa:** 3-4 dias

---

## 2. Fase 2B — RAG (Knowledge Base) — Prioridade MEDIA

**O que e:** Permitir que bots IA respondam com base em documentos da empresa.

### Fluxo:

```
Admin faz upload de PDF/DOCX/TXT
        |
        v
Sistema extrai texto -> quebra em pedacos (chunks)
        |
        v
Gera embeddings via OpenAI -> armazena no PostgreSQL (pgvector)
        |
        v
Cliente manda mensagem -> busca chunks relevantes -> injeta no prompt
        |
        v
GPT responde com base nos documentos reais da empresa
```

### Componentes:

| Componente | Descricao |
|-----------|-----------|
| pgvector | Extensao PostgreSQL para busca vetorial |
| knowledge_bases | Tabela de colecoes de documentos |
| knowledge_documents | Tabela de documentos individuais (PDF, DOCX, etc.) |
| knowledge_chunks | Tabela de pedacos com embeddings (vector 1536) |
| Pipeline | BullMQ job: upload -> extrair texto -> chunk -> embed -> insert |
| Vector search | Query com distancia coseno para encontrar chunks relevantes |
| Integracao | Injetar chunks no system prompt do bot antes de chamar LLM |
| Frontend | Pagina de gestao de knowledge bases + upload de docs |

**Estimativa:** 4-5 dias

---

## 3. Ajustes e Melhorias Pendentes

### 3.1 Bot — Ajustes Menores

| Ajuste | Status |
|--------|--------|
| Campo API Key opcional no create (usar env var global) | Pendente |
| Endpoint de teste para bots builtin (testar LLM sem salvar) | Pendente |
| Cleanup job para bot_events (deletar > 30 dias) | Pendente |
| Paginacao com total count no GET /bots/:id/events | Pendente |
| Testar fluxo completo E2E (mensagem real -> bot responde) | Pendente |

### 3.2 UI/UX

| Ajuste | Status |
|--------|--------|
| Dropdown bg na Bot Configuration do inbox | Corrigido |
| Botao "Desconectar bot" funcional | Corrigido |
| Revisar telas de Settings pixel a pixel vs Chatwoot | Pendente |
| Consistencia do dark theme em todas as paginas | Pendente |

---

## 4. Ordem Sugerida de Implementacao

### Fase Atual (concluida)
1. ~~Fase 1 — Bot Webhook~~ -- COMPLETO
2. ~~Fase 2A — Bot IA (OpenAI/Claude)~~ -- COMPLETO

### Proximo Sprint
3. **Testar fluxo completo** de bot IA (mensagem real)
4. **Automation** — maior valor imediato para uso interno

### Sprints Seguintes
5. **SLA** — ja temos infra base
6. **Fase 2B (RAG)** — diferencial competitivo
7. **Security** — necessario antes de producao
8. **Macros** — qualidade de vida dos atendentes
9. **Conversation Workflow** — auto-assign / round-robin

### Futuro
10. Integrations marketplace
11. Custom Roles
12. Help Center / Knowledge Portal (publico)

---

## 5. Diferenciais do Blossom Inbox vs Chatwoot

Features que **nos temos e o Chatwoot nao tem:**

| Feature | Descricao |
|---------|-----------|
| **Bot IA nativo** | Bots com OpenAI/Claude rodando DENTRO da plataforma (Chatwoot so tem webhook externo) |
| **Custom Actions** | Botoes que disparam webhooks com payload customizado (ex: cancelar pedido direto no sistema do cliente) |
| **API Keys** | Gestao de chaves de API para integracoes programaticas |
| **Queue Health** | Monitoramento de filas BullMQ em tempo real (waiting, active, failed) |
| **Blocklist** | Gestao de contatos bloqueados com interface dedicada |
| **Modulos customizaveis** | Abas 100% custom por cliente com frontend+backend proprio (ex: Logistica ACME) |

---

## 6. Estimativas Consolidadas

| Feature | Estimativa | Prioridade |
|---------|-----------|------------|
| Automation | 3-5 dias | ALTA |
| SLA | 2-3 dias | MEDIA |
| RAG (Knowledge Base) | 4-5 dias | MEDIA |
| Security | 2-3 dias | MEDIA |
| Macros | 2-3 dias | MEDIA |
| Conversation Workflow | 2-3 dias | BAIXA |
| Integrations | 1-2 dias/cada | BAIXA |
| Custom Roles | 3-4 dias | BAIXA |
| Ajustes de bot | 1 dia | ALTA |
| Review UI pixel-perfect | 2-3 dias | MEDIA |
| **TOTAL** | **~25-35 dias** | |

---

*Documento gerado em 20/04/2026 — Blossom Inbox v0.1*
