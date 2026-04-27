# Deploy — Axis Backend

Procedimento de lançamento em produção. Stack alvo:

- **Render** — back + front (Web Services Docker)
- **Neon** — PostgreSQL serverless (mesma conta usada no Tenet)
- **Upstash** — Redis serverless (free tier)
- **Google Cloud Storage** — bucket `axis-files` (mesmo projeto GCP do Tenet)
- **Cloudflare** — DNS + CDN (depois que tiver domínio)

Tempo estimado do zero ao ar: ~2 horas.

---

## 0. Pré-requisitos

- [ ] Acesso a uma conta GCP onde já roda o Tenet (mesmo projeto)
- [ ] Acesso a uma conta Neon (mesma usada no Tenet)
- [ ] Conta Render conectada ao GitHub `VictorFujiyama/axis-back` e `axis-front`
- [ ] `JWT_SECRET` e `ENCRYPTION_KEY` gerados e guardados em local seguro
- [ ] Domínio comprado (opcional na primeira subida — pode usar URL `*.onrender.com` inicialmente)

### Gerar secrets (se ainda não fez)

```bash
# JWT_SECRET — 64 bytes hex
openssl rand -hex 64

# ENCRYPTION_KEY — 32 bytes base64 (CRITICAL — perda = dados cifrados viram lixo)
openssl rand -base64 32
```

Guardar em pelo menos 2 lugares:
1. 1Password / Bitwarden
2. Cofre físico ou Google Drive cifrado

---

## 1. Bucket GCS + Service Account

No console GCP, no projeto que tem o `tenetimages`:

1. **Cloud Storage → Buckets → Create bucket**
   - Nome: `axis-files` (se não estiver disponível globalmente, usar `blossom-axis-files`)
   - Location type: `Region` → mesma região do Neon (us-east-2 / Ohio se estiver disponível, senão us-central1)
   - Storage class: Standard
   - Access control: **Uniform**
   - Public access: **Allow public access** (precisa para URLs `https://storage.googleapis.com/...` funcionarem direto)

2. **IAM & Admin → Service Accounts → Create service account**
   - Name: `axis-storage`
   - ID: `axis-storage`
   - Sem roles no projeto (concedemos só no bucket)

3. **Voltar ao bucket `axis-files` → Permissions → Grant access**
   - Principal: `axis-storage@<projeto>.iam.gserviceaccount.com`
   - Role: `Storage Object Creator` (menor privilégio: cria objetos, não lista nem deleta).
     Se um dia precisar de cleanup automático, considere `Storage Object User` (preview).

4. **Tornar bucket público para leitura:**
   - Bucket → Permissions → Grant access
   - Principal: `allUsers`
   - Role: `Storage Object Viewer`

5. **Gerar chave JSON da service account:**
   - Service Accounts → `axis-storage` → Keys → Add Key → Create new key → JSON
   - Baixa o arquivo `.json` e guarda — vai virar a env var `GOOGLE_APPLICATION_CREDENTIALS_JSON`

---

## 2. Neon — banco Postgres

1. [console.neon.tech](https://console.neon.tech) → New Project
2. Nome: `axis-prod`, region: us-east-2 (Ohio) — match com Render
3. Postgres version: 16
4. Database name: `axis`
5. Após criar, copiar a **connection string** (começa com `postgresql://...neon.tech/...?sslmode=require`)
6. Plano free serve para começar (0.5GB). Upgrade para Launch (US$ 19/mo) quando passar disso.

---

## 3. Upstash — Redis

1. [console.upstash.com](https://console.upstash.com) → Create Database
2. Type: **Redis**
3. Name: `axis-redis`
4. Region: `us-east-1` (mais próxima de Render Ohio entre as opções Upstash)
5. Plan: **Free**
6. Após criar: copiar a `REDIS_URL` (formato `rediss://default:<token>@<host>:6379`) — atenção ao `rediss://` (TLS), não `redis://`
7. Copiar também a "REST URL" e "REST Token" se for usar via REST (não é o caso — BullMQ usa TCP via `ioredis`)

---

## 4. Render — Backend (axis-back)

### 4.1 Criar serviço

1. [Render dashboard](https://dashboard.render.com) → New → Blueprint
2. Selecionar repositório `VictorFujiyama/axis-back`, branch `main`
3. O Render detecta `render.yaml` e cria o serviço `axis-back`

### 4.2 Configurar Environment Variables

Na aba **Environment** do serviço `axis-back`, adicionar (todas como Secret quando indicado):

| Chave | Valor | Secret? |
|---|---|---|
| `DATABASE_URL` | connection string Neon (com `?sslmode=require`) | ✅ |
| `REDIS_URL` | connection string Upstash (`rediss://...`) | ✅ |
| `JWT_SECRET` | gerado em passo 0 | ✅ |
| `ENCRYPTION_KEY` | gerado em passo 0 | ✅ CRÍTICO |
| `CORS_ORIGINS` | `https://axis-front.onrender.com` (ou domínio real depois) | ❌ |
| `PUBLIC_API_URL` | `https://axis-back.onrender.com` (ou domínio real depois) | ❌ |
| `GCS_BUCKET_NAME` | `axis-files` (ou `tenetimages` se compartilhar) | ❌ |
| `GCS_PATH_PREFIX` | vazio se bucket dedicado, `axis` se compartilhar com Tenet | ❌ |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | conteúdo inteiro do JSON da service account, em uma linha | ✅ |
| `OPENAI_API_KEY` | sua chave | ✅ |
| `ANTHROPIC_API_KEY` | sua chave | ✅ |
| `ENABLED_MODULES` | `logistica-acme` (ou vazio) | ❌ |

> **Como colar o JSON na env var:** abra o `.json` baixado em passo 1, copie todo o conteúdo, cole no campo Value. Render aceita JSON multiline em env var, mas se der problema, use `tr -d '\n' < key.json` para colar como uma linha só.

### 4.3 Deploy inicial

- Render builda automaticamente. Acompanhe os logs em "Logs".
- O `preDeployCommand: pnpm db:migrate` roda antes de subir o container — espera as migrations passarem.
- Health check em `/api/v1/health` precisa retornar 200 para o serviço entrar em "Live".

### 4.4 Smoke test

```bash
curl https://axis-back.onrender.com/api/v1/health
# esperado: {"status":"ok",...}
```

---

## 5. Render — Frontend (axis-front)

### 5.1 Criar serviço

1. Render dashboard → New → Blueprint
2. Selecionar `VictorFujiyama/axis-front`, branch `main`

### 5.2 Build args (importante)

`NEXT_PUBLIC_*` precisam estar disponíveis em **build time**, não só runtime, porque o Next.js os inlina no bundle JS estático. No serviço `axis-front`:

- **Settings → Docker → Build Args** (ou no Blueprint detalhado):
  - `NEXT_PUBLIC_API_URL` = `https://axis-back.onrender.com`
  - `NEXT_PUBLIC_WS_URL` = `wss://axis-back.onrender.com`

### 5.3 Environment Variables

Mesmos valores como envs runtime (Next também lê em runtime):

| Chave | Valor |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://axis-back.onrender.com` |
| `NEXT_PUBLIC_WS_URL` | `wss://axis-back.onrender.com` |

### 5.4 Smoke test

Abrir `https://axis-front.onrender.com` no browser → tela de login deve carregar.

---

## 6. Criar usuário admin

Sem UI de signup. Rodar via shell do Render (Settings → Shell) no serviço `axis-back`:

```bash
pnpm seed:admin
```

Ou, se o script pedir prompts e não der pra usar shell interativo, conectar direto no Neon e inserir manualmente. Ver `src/scripts/seed-admin.ts`.

---

## 7. Twilio — atualizar webhooks

Quando o Axis em produção receber um inbox WhatsApp, ele auto-reescreve o `callback_url` do sender Twilio com `PUBLIC_API_URL`. Ou seja:

- **Inbox novo:** criar via UI do Axis em produção → Twilio é atualizado automaticamente
- **Inbox que já existia em dev (ngrok):** **deletar e recriar** em produção, OU rodar manualmente `POST /WhatsAppSenders/{sid}` na API Twilio com a URL nova

Não desligar o ngrok antes de validar que mensagem real chega no axis-back de produção.

---

## 8. Domínio (quando comprar)

1. Comprar `axisapp.com.br` no Registro.br (ou similar)
2. Criar conta Cloudflare (free), adicionar domínio
3. Trocar nameservers do Registro.br para os do Cloudflare
4. Em Cloudflare DNS, criar 2 registros CNAME:
   - `api.axisapp.com.br` → `axis-back.onrender.com` (Proxy: OFF inicialmente)
   - `app.axisapp.com.br` → `axis-front.onrender.com` (Proxy: OFF inicialmente)
5. Em Render, em cada serviço: Settings → Custom Domain → adicionar o subdomínio
6. Render emite cert Let's Encrypt automático (1-5 min)
7. Atualizar env vars `CORS_ORIGINS`, `PUBLIC_API_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` com as URLs novas
8. Trigger redeploy do front (build args mudaram)
9. Testar tudo com domínio
10. Ligar Cloudflare Proxy (nuvem laranja). Se WS quebrar em `api.`, deixa OFF nele e ON só em `app.`

---

## 9. Backup e segurança

- [ ] Neon faz snapshot automático (PITR no plano Launch). Free tier: ativar manualmente em Neon Dashboard → Backup
- [ ] `ENCRYPTION_KEY` está em 1Password **E** outro lugar offline?
- [ ] Service account JSON do GCP está em local seguro?
- [ ] Habilitar 2FA no Render, Neon, Cloudflare, GCP, Upstash

---

## 10. Custos esperados

| Item | Custo mensal |
|---|---|
| Render axis-back (Starter) | US$ 7 |
| Render axis-front (Starter) | US$ 7 |
| Neon (Free → Launch quando crescer) | US$ 0 → US$ 19 |
| Upstash Redis (Free) | US$ 0 |
| GCS (storage + egress) | < US$ 1 |
| **Total inicial** | **~US$ 14-15** |
| Total quando passar do free Neon | ~US$ 34 |

Domínio: ~R$ 40/ano (Registro.br) ou US$ 10/ano (Cloudflare Registrar).

---

## Pausar para economizar

Quando não estiver usando:

- **Render axis-back e axis-front** → Settings → Suspend Service (US$ 0 enquanto suspenso)
- **Neon free** → auto-pausa sozinha após inatividade
- **Upstash free** → sempre grátis até 10k commands/dia
- **GCS** → cobrança mínima de armazenamento

Custo idle total: **~US$ 0**.

Para reativar: Render → Resume Service (back + front), ~30s.
