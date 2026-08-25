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
- Auth is **Bearer** (API v2), not Basic
- Listings without lat/lng or city cannot be pushed (mapper throws)
- Amenity names are mapped best-effort; unknown Hostaway amenities are skipped
- Auto-sync refreshes availability/rates on an interval; content re-push is off by default (`CHECK24_AUTO_SYNC_CONTENT=false`)
