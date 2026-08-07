# Vermietung Middleware (fonio.ai ↔ Hostaway)

Secure middleware API for **brainions Vermietung**, connecting fonio.ai phone assistant to Hostaway booking data.

## Stack

- **NestJS** + TypeScript
- **PostgreSQL** + Prisma ORM
- **Redis** (reserved for future job queues)
- **Docker Compose** for local database services

## Quick start (local)

### 1. Install dependencies

```bash
npm install
```

### 2. Environment

Copy `.env.example` to `.env` and fill in credentials (`.env` is gitignored):

```bash
cp .env.example .env
```

### 3. Start PostgreSQL + Redis

**Option A — Docker (recommended)**

```powershell
.\scripts\setup-local.ps1 -Migrate
```

Or manually:

```bash
npm run docker:up
npm run prisma:generate
npm run prisma:deploy
```

> Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/). If `docker` is not found, install Docker Desktop first.

**Option B — Local PostgreSQL**

Install PostgreSQL 16, create database/user `vermietung`, then set `DATABASE_URL` in `.env` and run:

```bash
npm run prisma:generate
npm run prisma:deploy
```

### 4. Run API

```bash
npm run start:dev
```

- API: http://localhost:3000
- Swagger: http://localhost:3000/docs
- Admin UI: http://localhost:3000/admin
- Health: http://localhost:3000/health

### 6. Initial sync from Hostaway

Login as admin (default from `.env`):

```bash
curl -X POST http://localhost:3000/api/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@brainions.digital\",\"password\":\"ChangeMe123!\"}"
```

Then trigger sync:

```bash
curl -X POST http://localhost:3000/api/v1/admin/sync \
  -H "Authorization: Bearer YOUR_ADMIN_JWT"
```

## fonio.ai endpoints

All fonio endpoints require header: `x-api-key: YOUR_FONIO_API_KEY`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/fonio/call-context` | Inbound call webhook |
| GET | `/api/v1/fonio/availability` | Search availability (no PII) |
| POST | `/api/v1/fonio/guest/verify` | Guest verification |
| GET | `/api/v1/fonio/guest/reservation` | Verified reservation summary |
| POST | `/api/v1/fonio/guest/requests` | Guest requests + rule engine |

## Admin endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/admin/auth/login` | Admin login |
| GET | `/api/v1/admin/listings` | Synced listings |
| POST | `/api/v1/admin/sync` | Trigger Hostaway sync |
| GET/POST | `/api/v1/admin/rules` | Approval rules |
| GET/PATCH | `/api/v1/admin/verification-config` | Verification settings |

## Client overview

See **[docs/CLIENT_OVERVIEW.md](docs/CLIENT_OVERVIEW.md)** for the two main use cases (existing guests vs fast availability), Hostaway messaging credentials, and deliverables checklist.

## Security & privacy

See **[docs/SECURITY.md](docs/SECURITY.md)** for GDPR practices, roles, HTTPS, and credential handling.

See **[docs/MONITORING.md](docs/MONITORING.md)** for health checks and error logging.

- **API docs:** [Swagger UI](/docs) at `/docs` when running
- **No secrets in frontend** — admin UI uses JWT only; fonio uses server-side `x-api-key`
- **Roles:** VIEWER (read-only, masked PII) · EDITOR (operations) · ADMIN (full config)

## Webhooks

- `POST /webhooks/hostaway` — Hostaway unified webhooks (optional Basic Auth)
- `POST /webhooks/check24/bookings` — CHECK24 booking webhook (optional Basic Auth)

## CHECK24

Optional CHECK24 Ferienwohnungen Supply API sync (content + availability/rates + inbound bookings). See **[docs/CHECK24.md](docs/CHECK24.md)**.

## Production domain

Configured for: `vermietung.brainions.digital`

## GDPR log retention (defaults)

See `docs/SECURITY.md`. Expired audit logs are purged automatically daily.

## Project structure

```
src/
  admin/          Admin API + JWT auth
  fonio/          fonio-facing endpoints
  hostaway/       Hostaway client + sync + messaging
  rules/          Rule engine for guest requests
  webhooks/       Hostaway webhook receiver
  logging/        Audit log with retention
  prisma/         Database service
```

## Docker (full stack)

```bash
docker compose --profile full up -d --build
```

## Production deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for deploying to `vermietung.brainions.digital` with Docker + Caddy.

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## fonio.ai prompt templates

German prompt files for fonio configuration:

- `docs/fonio-prompt-startnachricht.txt` — greeting template
- `docs/fonio-prompt-system-de.txt` — system prompt
- `docs/fonio-tools-config.json` — API tool reference
- `docs/FONIO_SETUP.md` — step-by-step setup guide

## Security notes

- Never commit `.env`
- Rotate API keys before production
- fonio.ai must not call Hostaway directly — only this middleware
