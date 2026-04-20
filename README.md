# Axis Back

API backend for the Axis customer support platform.

## Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Fastify
- **Database:** PostgreSQL (Drizzle ORM)
- **Queue:** BullMQ + Redis
- **Auth:** JWT + Argon2

## Setup

```bash
# 1. Start database and Redis
pnpm docker:up

# 2. Install dependencies
pnpm install

# 3. Copy environment variables
cp .env.example .env
# Edit .env with your values

# 4. Run migrations
pnpm db:migrate

# 5. Seed admin user
pnpm seed:admin

# 6. Start dev server
pnpm dev
```

Server runs on `http://localhost:3200`.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server with hot reload |
| `pnpm build` | Build for production |
| `pnpm start` | Start production server |
| `pnpm db:generate` | Generate migration from schema changes |
| `pnpm db:migrate` | Run pending migrations |
| `pnpm db:studio` | Open Drizzle Studio (DB GUI) |
| `pnpm seed:admin` | Create initial admin user |
| `pnpm type-check` | TypeScript type checking |
