# CHECK24 Ferienwohnungen — Supply API integration

This middleware pushes Hostaway inventory to the **CHECK24 Vacation Rental Supply API v2** and imports bookings back into Hostaway.

## Prerequisites

1. CHECK24 partner account (staging or live)
2. Bearer token from the Supply API account page (`Test Token` / `Live Token`)
3. Local listings + calendars already synced from Hostaway (`POST /api/v1/admin/sync`)

## Environment

```env
CHECK24_ENABLED=true
CHECK24_API_TOKEN=test_...
CHECK24_API_BASE_URL=https://supplyapistaging.ferienwohnung.check24-test.de/api/v2
# Production (when CHECK24 activates live):
# CHECK24_API_BASE_URL=https://supplyapi.ferienwohnung.check24.de/api/v2

CHECK24_TERMS_URL=https://brainions.digital/agb
CHECK24_HOST_TYPE=professional
CHECK24_PARTNER_DISPLAY_NAME=brainions Vermietung
CHECK24_CONTACT_EMAIL=vermietung@brainions.de
CHECK24_TEST_PROPERTY=true
CHECK24_ENQUIRY_ONLY=false
CHECK24_AUTO_ACCEPT_ENQUIRY=true
CHECK24_HOSTAWAY_CHANNEL_ID=2000
# CHECK24_HOSTAWAY_CUSTOM_FIELD_ID=
# CHECK24_HOSTAWAY_BUCHUNGSPORTAL_VALUE=CHECK24

CHECK24_WEBHOOK_USERNAME=
CHECK24_WEBHOOK_PASSWORD=
CHECK24_AUTO_SYNC=true
CHECK24_AUTO_SYNC_CONTENT=false
CHECK24_SYNC_INTERVAL_MINUTES=30
CHECK24_BOOKING_POLL_INTERVAL_MINUTES=10
```

> Tip: After first boot, **Automatic updates** on the Admin CHECK24 tab overrides these env defaults (stored in the database).

## What gets synced

| Direction | Data |
|-----------|------|
| Hostaway → CHECK24 | Property content (name, address, geo, amenities, images, cancellation/payment defaults) |
| Hostaway → CHECK24 | Availability + min stay (from local `CalendarDay` cache) |
| Hostaway → CHECK24 | Standard nightly rates (from `CalendarDay.price`) |
| CHECK24 → Hostaway | Bookings / enquiries → `POST /reservations` with `channelId` (`CHECK24_HOSTAWAY_CHANNEL_ID`) plus custom field **Buchungsportal** = `CHECK24` |

Property IDs are stable: `ha-{hostawayListingId}` (prefix via `CHECK24_PROPERTY_ID_PREFIX`).

## Admin API

All routes require admin JWT + permissions (`SYNC_RUN`, `WEBHOOKS_MANAGE`, etc.).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/admin/check24/status` | Enabled/configured + ping |
| `GET` | `/api/v1/admin/check24/mappings` | Property mappings |
| `GET` | `/api/v1/admin/check24/preview/:hostawayId` | Preview mapped payload |
| `POST` | `/api/v1/admin/check24/sync` | Full push (content + ARI) |
| `POST` | `/api/v1/admin/check24/sync/:hostawayId/content` | One listing content |
| `POST` | `/api/v1/admin/check24/webhooks/bookings/register` | Register booking webhook |
| `POST` | `/api/v1/admin/check24/bookings/poll` | Pull recent bookings |
| `GET` | `/api/v1/admin/check24/bookings` | Local CHECK24 booking log |

Webhook receiver (public):

```
POST /webhooks/check24/bookings
```

Optional Basic auth via `CHECK24_WEBHOOK_*`.

## Recommended go-live sequence

1. Set staging token + `CHECK24_ENABLED=true` + `CHECK24_TEST_PROPERTY=true`
2. Run Hostaway sync so calendars are warm
3. `GET .../check24/preview/{hostawayId}` for a sample listing
4. `POST .../check24/sync` (first content + availability + rates)
5. Register webhook + optionally poll bookings
6. Validate one test booking end-to-end
7. Switch to live token / production base URL when CHECK24 approves

## Notes

- CHECK24 docs/UI: staging login at `https://supplyapistaging.ferienwohnung.check24-test.de/login`
- OpenAPI: `https://supplyapistaging.ferienwohnung.check24-test.de/api/v2/openapi.json`
- Auth is **Bearer** (API v2), not Basic
- Listings without lat/lng or city cannot be pushed (mapper throws)
- Amenity names are mapped best-effort; unknown Hostaway amenities are skipped
- Auto-sync refreshes availability/rates on an interval; content re-push is off by default (`CHECK24_AUTO_SYNC_CONTENT=false`)

## Cancellation flow

| Direction | Behaviour |
|-----------|-----------|
| Guest cancels on CHECK24 | Webhook/poll → cancel Hostaway reservation → **always** push availability (reopen dates) |
| Provider cancels in Hostaway (UI / unpaid auto-cancel) | `POST /bookings/{id}/cancel` with `cancelledBy=Provider` → push availability |

Cancel payload requires `cancelledBy` + `cancelReason` (see Supply API `CancelBooking` schema).

## Pre-check-in / Anreise after payment

CHECK24 imports create the Hostaway reservation **without** guest email/phone on Hostaway, and **do not** attach contact until the first qualifying payment is applied. Contact is stored locally only so Hostaway “at reservation” email/WhatsApp automations have no recipient. Buchungsportal / external booking number are set on **create** when possible (avoids a follow-up update that can re-trigger automations). After payment, the middleware pushes contact to Hostaway and then sends Anreise / check-in templates.

### Welcome message on import (not Anreise)

Immediately after import the middleware also sends a **guest welcome** via Hostaway **email** and **WhatsApp** (when email/phone exist locally). The welcome confirms the booking and includes the payment link when available — it does **not** include address/PIN/Anreise. Contact is attached only for the send, then stripped from Hostaway again so Anreise automations stay blocked until payment.

WhatsApp delivery requires Hostaway WhatsApp to be enabled on the account; free-form first messages may fail if Hostaway requires an approved template (email is the reliable path via the CHECK24 `fwd-…@bos.fewo.check24.de` relay).

**Still required in Hostaway:** set Inbox automations that send pre-check-in on “reservation” to also require **Payment status = paid** (or disable them for the CHECK24 channel / Buchungsportal=CHECK24). Channel-only rules that do not need email can still fire — those must be payment-gated in Hostaway. Guest portal must not show door codes / exact address until paid.

## Cancellation → availability

After cancel, the middleware:

1. Cancels in Hostaway and marks the local reservation cancelled
2. Syncs calendar, then **force-opens** cancelled nights `[dateFrom, dateTo)` (upserts missing days; skips nights still covered by another active booking)
3. Pushes availability to CHECK24
4. Retries at ~45s, 5m, and 15m (`CHECK24_CANCEL_AVAILABILITY_RETRY_MS`)
5. On every later ARI sync for **24h** (`CHECK24_CANCEL_FORCE_OPEN_HOURS`), re-applies that reopen so Hostaway calendar lag cannot leave CHECK24 closed

## Hostaway checklist (operator)

See the client email template in ops notes / reply from engineering: payment-gated Anreise automations, channel rules, guest portal check-in visibility, Buchungsportal custom field.
