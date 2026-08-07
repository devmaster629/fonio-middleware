# Client Overview — Final Outcome

This document aligns **brainions Vermietung**, **fonio.ai**, and **Hostaway** on what the middleware delivers.

**Production URL:** `https://vermietung.brainions.digital`  
**Domain:** `brainions.digital` (middleware subdomain: `vermietung`)

---

## Optional channel: CHECK24

When enabled, the middleware can push Hostaway listings / availability / rates to the **CHECK24 Ferienwohnungen Supply API** and import bookings back into Hostaway. See **[CHECK24.md](./CHECK24.md)**.

---

## Two main use cases

### Use case 1 — Existing guests (verification → requests)

**Goal:** A guest with a valid reservation can make changes or submit requests after identity verification.

**Flow:**

```
Phone call → fonio greets (optional caller hint, no booking details)
          → Guest provides reservation #, phone, dates, etc.
          → POST /api/v1/fonio/guest/verify
          → JWT verificationToken
          → GET /guest/reservation OR POST /guest/requests
          → Rules engine (auto / forward to team / deny)
          → Manual requests → Hostaway inbox message for your team
```

**Admin:** Configure verification fields and approval rules per property under **Rules & verification**.

---

### Use case 2 — New availability inquiries (fast, no interruption)

**Goal:** During a live phone call, availability checks must **not** block the conversation with long Hostaway API waits.

**Architecture:**

| Layer | Behaviour |
|-------|-----------|
| **Background sync** | Full sync + calendar cache refreshed on schedule (default every 30 min) |
| **fonio availability API** | **Cache-first** — answers from local DB in typically &lt;200 ms |
| **Optional live refresh** | `?liveRefresh=true` hits Hostaway live (slower; not used during calls by default) |

**fonio behaviour (prompt):**

- Before availability tool: *"Einen Moment, ich schaue nach freien Unterkünften…"*
- Before verify: *"Einen Moment, ich prüfe Ihre Buchung…"*

**Important:** Run an initial **Hostaway sync** after deploy so calendar cache is populated. Until then, some listings may show `availabilityUnknown: true`.

---

## Property hierarchy (parent + apartments)

Some listings are **parent properties** (entire house) and **child apartments** in the same building.

Configured in `src/hostaway/listing-hierarchy.config.ts`:

| Group | Parent | Mode |
|-------|--------|------|
| Bergdomizil | 175206 | BOTH (whole house + apartments) |
| Kornbergstraße 2.OG / 3.OG / 4.OG | per floor | BOTH |
| Standalone listings | — | individual |

**Admin → Groups** shows synced groups. `availabilityMode` controls whether fonio offers parent, children, or both.

---

## Hostaway API credentials (Messaging / Inbox)

The middleware uses the **Hostaway Public API** with `scope: general` (same credentials as listings/reservations).

**Messaging endpoints used:**

| Endpoint | Purpose |
|----------|---------|
| `GET /conversations?reservationId=` | Find guest conversation |
| `GET /conversations/{id}/messages` | Admin preview |
| `POST /conversations/{id}/messages` | Forward guest requests to inbox |

**Confirmation:** Run locally:

```bash
npm run test:hostaway
```

If **listings** work but **conversations** return 403/empty, contact Hostaway support to confirm Messaging API access on your account. No separate credential type is required in our integration — it is the same API key with sufficient permissions.

---

## GDPR log retention (as agreed)

| Log type | Default retention | Config |
|----------|-------------------|--------|
| Development / debug | 14 days | `LOG_RETENTION_DEBUG_DAYS` (7–14) |
| Operational / security | 30 days | `LOG_RETENTION_OPERATIONAL_DAYS` |
| Maximum cap | 90 days | `LOG_RETENTION_MAX_DAYS` |
| PII-related metadata | 30 days max | `LOG_RETENTION_PII_DAYS` |

IPs are **hashed**; no raw tokens/passwords in audit logs. Automatic purge daily at 03:00.

---

## Technical deliverables checklist

| Item | Status |
|------|--------|
| NestJS middleware backend | Done |
| REST API for fonio.ai | Done |
| Hostaway Public API integration | Done |
| Admin dashboard (rules, settings, sync) | Done |
| PostgreSQL (config, logs, mappings) | Done |
| Linux VPS deployment (Docker + Caddy) | Documented |
| API documentation (Swagger `/docs`) | Done |
| Security & GDPR (`docs/SECURITY.md`) | Done |
| Deployment guide (`docs/DEPLOYMENT.md`) | Done |
| Health monitoring (`/health`) | Done |
| Error logging (audit + Docker logs) | Done |

---

## What you configure in fonio (not in code)

1. System prompt from `docs/fonio-prompt-system-de.txt`
2. Tools from `docs/fonio-tools-config.json`
3. Webhook URL: `https://vermietung.brainions.digital/api/v1/fonio/call-context`
4. Header: `x-api-key: <FONIO_API_KEY from server .env>`

See `docs/FONIO_SETUP.md` for step-by-step instructions.
