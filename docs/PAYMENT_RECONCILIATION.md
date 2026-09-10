# Payment Reconciliation (Qonto / PayPal → Hostaway)

Generic automation platform for importing external payments, matching them to Hostaway reservations, and applying paid charges.

## What is built

| Component | Status |
|-----------|--------|
| `ExternalPayment` database model | Done |
| Matcher (amount, name, email, reservation #, listing, dates, reference) | Done |
| Auto-apply when unambiguous | Done |
| Review queue + one-click confirm / skip | Done |
| Admin **Payments** tab | Done |
| Qonto webhook `POST /webhooks/qonto` | Ready (disabled until `QONTO_ENABLED=true`) |
| PayPal webhook `POST /webhooks/paypal` | Ready (disabled until `PAYPAL_ENABLED=true`) |
| Manual test ingest `POST /api/v1/admin/payments/ingest-manual` | Done |

## Client prerequisites (required before go-live)

### 1. Qonto

| Item | Required |
|------|----------|
| Qonto business account with API access | Yes |
| OAuth app: `QONTO_CLIENT_ID`, `QONTO_CLIENT_SECRET` | Yes |
| Organization slug (`QONTO_ORGANIZATION_SLUG`) | Yes |
| Webhook URL: `https://vermietung.brainions.digital/webhooks/qonto` | Yes |
| Webhook secret (`QONTO_WEBHOOK_SECRET`) | Recommended |
| Set `QONTO_ENABLED=true` in server `.env` | Yes |

### 2. PayPal

| Item | Required |
|------|----------|
| PayPal Business account | Yes |
| REST app (sandbox first, then live) | Yes |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Yes |
| Webhook URL: `https://vermietung.brainions.digital/webhooks/paypal` | Yes |
| `PAYPAL_WEBHOOK_ID` (after registering webhook) | Yes |
| `PAYPAL_MODE=sandbox` or `live` | Yes |
| Set `PAYPAL_ENABLED=true` in server `.env` | Yes |

### 3. Hostaway (already in place)

| Item | Required |
|------|----------|
| API credentials | Already configured |
| Reservations synced locally | Run Hostaway sync regularly |
| Guest conversations linked | Admin → Link inbox & retry |

### 4. Business rules to confirm

| Decision | Default in v1 |
|----------|----------------|
| Auto-apply minimum match score | `85` (`PAYMENT_AUTO_MATCH_MIN_SCORE`) |
| Candidate arrival window | past departures −30 days → arrivals up to **+730 days** (2 years) |
| Partial payments | → review queue (not auto) |
| Refunds (negative amounts) | → skipped |
| Bulk payments (> €50,000) | → skipped |
| Ambiguous matches | → review queue |
| **Installment payment plans** (middleware ledger) | Editable next due / frequency; matcher prefers next due over remaining balance |

## Installment payment plans

For long-term stays (e.g. monthly €550), Admin → **Payments → Payment plans** stores per Hostaway reservation:

- installment amount + frequency (weekly / semi-monthly / monthly / custom days)
- **next amount due** + optional next due date
- paid toward plan (advanced automatically when a bank payment is applied)

Hostaway remains source of truth for guest, stay dates, and booking total. Matched payments update the local ledger (`paidTowardPlan`, advance `nextDueAt` / `nextDueAmount`). Undo reverses the ledger best-effort.

**Auto-apply:** when an enabled plan’s **next amount due** equals the bank payment and the guest name/email matches, the payment is applied automatically (even if other same-guest bookings look similar). Saving a plan re-runs the review queue immediately. Deleting a plan restores any **auto-applied** payments for that reservation back to the review queue (manually confirmed payments are left alone).

If Hostaway rejects the charge (e.g. **archived listing** → HTTP 403), the payment stays in the **review queue** with the error shown — it is not moved to History as Failed.

API:

- `GET /api/v1/admin/payments/payment-plans`
- `GET|PATCH|DELETE /api/v1/admin/payments/payment-plans/:hostawayId`

## Testing without Qonto/PayPal

Admin API (after login):

```http
POST /api/v1/admin/payments/ingest-manual
{
  "source": "MANUAL",
  "externalId": "test-001",
  "amount": 250,
  "payerName": "Max Mustermann",
  "payerEmail": "max@example.com",
  "reference": "Reservierung 62144308 Wiesenblick"
}
```

Or use Admin → **Payments** tab to confirm review-queue items.

## Architecture

```
Qonto / PayPal webhook
    → PaymentIngestService (normalize)
    → PaymentMatcherService (score reservations)
    → PaymentReconciliationService (auto vs review)
    → PaymentApplyService (Hostaway charge + inbox note)
```

Future automations can follow the same pattern: **ingest → decide → apply → notify**.
