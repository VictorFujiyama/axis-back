# syntax=docker/dockerfile:1.7

# ====== Stage 1: install all deps (cached on lockfile change) ======
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY modules/logistica-acme/package.json ./modules/logistica-acme/

RUN pnpm install --frozen-lockfile

# ====== Stage 2: build ======
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Copy source first, then node_modules from deps. Re-link workspaces so each
# packages/*/node_modules is wired up — `COPY . .` would clobber them otherwise.
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN pnpm install --frozen-lockfile --offline --prefer-offline

RUN pnpm build

# ====== Stage 3: runtime ======
FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/modules ./modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/pnpm-lock.yaml ./

RUN addgroup -S axis && adduser -S axis -G axis
USER axis

EXPOSE 3200

# Run migrations on every start. Drizzle migrate is idempotent — fast no-op
# when nothing's changed. Lets us deploy on Render Free tier (no preDeploy).
CMD ["sh", "-c", "pnpm db:migrate && node dist/server.js"]
