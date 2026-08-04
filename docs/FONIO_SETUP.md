# fonio.ai Integration Guide

Configure your fonio phone assistant to use this middleware.

## Quick URL reference

Get live URLs from the API:

```
GET /api/v1/fonio/setup
Header: x-api-key: <your fonio key>
```

Or after admin login:

```
GET /api/v1/admin/fonio-setup
```

## Local development

| fonio setting | URL |
|---------------|-----|
| Inbound webhook | `http://localhost:3000/api/v1/fonio/call-context` |
| Availability (mid-call API) | `GET http://localhost:3000/api/v1/fonio/availability` |
| Guest verify | `POST http://localhost:3000/api/v1/fonio/guest/verify` |
| Guest reservation | `GET http://localhost:3000/api/v1/fonio/guest/reservation` |
| Guest requests | `POST http://localhost:3000/api/v1/fonio/guest/requests` |
| Send check-in info (email) | `POST http://localhost:3000/api/v1/fonio/guest/send-checkin-info` |

**Auth header for all fonio endpoints:** `x-api-key: <FONIO_API_KEY from .env>`

## Production (when deployed)

Replace `localhost:3000` with `https://vermietung.brainions.digital`

## fonio dashboard steps

1. Open your fonio assistant → **Edit** → **Technical**
2. **Inbound webhook:** paste `call-context` URL
3. Add **API requests during call** for:
   - Availability questions
   - Guest verification
   - Guest reservation / requests
   - Send check-in info (Hostaway Anreise template by email)
4. Set API key header: `x-api-key`

## Suggested fonio prompt variables

After inbound webhook, fonio receives:

| Variable | Meaning |
|----------|---------|
| `caller_recognized` | Phone matched a reservation |
| `has_upcoming_booking` | Guest has active/upcoming stay |
| `guest_first_name_hint` | First name for greeting only (not verification) |
| `greeting_hint` | Ready-to-use German greeting |
| `hint_requires_verification` | Must verify before sharing booking details |
| `verification_hint_de` | German rule text (min match + enabled fields from Admin) |
| `verification_guest_script_de` | Short either/or sentence to say to the guest |
| `verification_instructions_de` | Full verification block for „Eigene Anweisungen“ |
| `verification_optional_fields_de` | Comma/or-list of enabled optional fields |
| `verification_min_match_count` | Minimum matching fields from Admin |
| `booking_offer_enabled` | Whether booking-offer API is active |

**Note:** The webhook does **not** return reservation ID or city before verification. fonio must call `guest/verify` first.

## Guest verification (admin)

Configure in **Admin → Rules & verification → Guest verification** (separate from approval rules):

| Field | Meaning |
|-------|---------|
| Stay dates | Always required (arrival + departure count as **one** match) |
| Property name | Partial match on listing name |
| Phone | Linked to booking |
| Email | Booking email |
| Reservation number | Optional — speeds up lookup |

Default: **3 of 5** scoring fields must match (stay dates always required as input).

The API returns a German `hint` field explaining either/or logic — use it in the fonio prompt when verification fails.

Test locally:

```bash
npm run test:verify -- --reservationId=62363926 --arrival=2026-08-08 --departure=2026-08-10 --phone=+4915150601701
npm run test:verify -- --arrival=2026-08-08 --departure=2026-08-10 --listingName=Wiesenblick --email=f.vollmer@yahoo.de
```

Use a real `hostawayId` from **Admin → Reservations**.

## Automatic booking offer

When availability is confirmed and the guest wants to book:

```
POST /api/v1/fonio/booking-offer
```

Required body: `listingId`, `checkIn`, `checkOut`, `guests`, `guestFirstName`, `guestLastName`, `guestEmail`, `phone`.

Creates a reservation/inquiry in Hostaway (channel 2000). Your team sends the offer from Hostaway — **do not quote prices on the phone**.

Enable/disable in **Admin → Rules & verification → Automatic booking offer (fonio)**.  
`BOOKING_OFFER_ENABLED=false` in `.env` only applies as fallback when no admin config exists yet.

## Example call flow

1. **Call starts** → fonio calls `call-context` with caller phone
2. **Availability question** → fonio says *"Einen Moment, ich schaue nach…"* → `GET /availability?city=Stuttgart&checkIn=...` (cache-first, fast)
3. **Existing guest** → fonio asks reservation ID + dates → `POST /guest/verify`
4. **Guest request** (pet, extra guest) → `POST /guest/requests` with `verificationToken`
5. **Manual requests** → posted to the Hostaway guest conversation inbox (middleware looks up conversation automatically)

## Hostaway inbox forwarding

When a request is not auto-approved (`FORWARDED` status), the middleware:

1. Resolves the Hostaway **conversation ID** for the reservation (cached or live API lookup)
2. Posts a German message to the guest conversation via Hostaway API
3. Your team sees it in Hostaway inbox as usual

If no conversation exists yet, the request is stored as **pending** — run **Admin → Guest requests → Link inbox & retry pending** or wait for the next sync (conversation backfill).

Message format: `[fonio.ai – Gästeanfrage]` + request type + rule reason + guest details.

## View API activity

Swagger → `GET /api/v1/admin/logs` (after admin login)

Shows `call_context`, `availability_search`, `guest_verify` events without storing PII.

## Test availability (local or production)

### Option A — npm script (recommended)

```bash
# API must be running; uses FONIO_API_KEY and APP_URL from .env
npm run test:availability

# Custom search
npm run test:availability -- --city=Stuttgart --checkIn=2026-08-01 --checkOut=2026-08-05 --guests=4 --pets=true
```

### Option B — Swagger

1. Open http://localhost:3000/docs (or production `/docs`)
2. Section **fonio** → `GET /api/v1/fonio/availability`
3. Click **Authorize** → enter `FONIO_API_KEY` as `x-api-key`
4. Fill `city`, `checkIn`, `checkOut`, `guests` → Execute

### Option C — curl

```bash
curl "http://localhost:3000/api/v1/fonio/availability?city=Stuttgart&checkIn=2026-07-10&checkOut=2026-07-15&guests=2&availableOnly=true" \
  -H "x-api-key: YOUR_FONIO_API_KEY"
```

**Before testing:** run **Hostaway Sync** in admin so listings and calendars exist in the database.

## Availability performance (phone calls)

The availability endpoint is **cache-first** by default:

| Query param | Default | Use |
|-------------|---------|-----|
| (none) | cache | Live phone calls — typically &lt;200 ms |
| `liveRefresh=true` | off | Admin/debug only — hits Hostaway live (slower) |

Response includes `meta.dataSource` (`cache` or `live`) and `meta.responseMs`.

Background sync (default every 30 min) keeps calendars fresh. If `availabilityUnknown: true` on a listing, calendar cache is incomplete — run sync or use `liveRefresh=true` only outside calls.

See `docs/CLIENT_OVERVIEW.md` for the two use cases (existing guests vs availability).

### Production test

Replace `localhost:3000` with `https://vermietung.brainions.digital` after deploy.
