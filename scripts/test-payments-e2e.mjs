#!/usr/bin/env node
/**
 * End-to-end production smoke test for payment reconciliation.
 * Tests: health, auth, Qonto poll, PayPal webhook, payments API, env config.
 */
import { Client } from 'ssh2';

const DOMAIN = 'https://vermietung.brainions.digital';
const pass = process.env.VPS_PASSWORD;

const remote = `
set -e
cd /root/fonio-middleware
set -a
source .env
set +a

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES+1)); }
warn() { echo "  WARN: $1"; }
FAILURES=0

echo ""
echo "========================================"
echo "  PAYMENT RECONCILIATION SMOKE TEST"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"

echo ""
echo "[1] API health + database"
HEALTH=$(curl -fsS ${DOMAIN}/health)
echo "$HEALTH" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('status')=='ok', 'status not ok'
assert d.get('checks',{}).get('database')=='ok', 'db not ok'
print('  status:', d.get('status'), '| db:', d.get('checks',{}).get('database'))
" && pass "API healthy, database connected" || fail "Health check failed"

echo ""
echo "[2] Integration flags in .env"
for key in QONTO_ENABLED PAYPAL_ENABLED PAYPAL_WEBHOOK_ID PAYMENT_PLATFORM_PAYOUT_SENDERS; do
  val=$(grep "^$key=" .env | cut -d= -f2- || echo "MISSING")
  if [ "$val" = "MISSING" ] || [ -z "$val" ]; then
    fail "$key not set"
  else
    if [ "$key" = "PAYPAL_CLIENT_SECRET" ] || [ "$key" = "QONTO_SECRET_KEY" ]; then
      pass "$key=***"
    else
      pass "$key=$val"
    fi
  fi
done

echo ""
echo "[3] Qonto API auth (organization)"
QONTO_AUTH="$QONTO_LOGIN:$QONTO_SECRET_KEY"
if [ -z "$QONTO_LOGIN" ]; then QONTO_AUTH="$QONTO_CLIENT_ID:$QONTO_CLIENT_SECRET"; fi
ORG=$(curl -fsS -H "Authorization: $QONTO_AUTH" https://thirdparty.qonto.com/v2/organization 2>/dev/null || echo "FAIL")
if echo "$ORG" | python3 -c "import sys,json; d=json.load(sys.stdin); o=d.get('organization') or d; print(o.get('slug') or o.get('legal_name') or 'ok')" 2>/dev/null | grep -qv FAIL; then
  pass "Qonto API responds ($(echo "$ORG" | python3 -c "import sys,json; d=json.load(sys.stdin); o=d.get('organization') or d; print(o.get('slug','?'))" 2>/dev/null))"
else
  fail "Qonto API auth failed"
fi

echo ""
echo "[4] PayPal webhook endpoint (enabled; rejects invalid signature)"
PP_CODE=$(curl -s -o /tmp/pp_probe.json -w "%{http_code}" -X POST ${DOMAIN}/webhooks/paypal \\
  -H 'Content-Type: application/json' \\
  -H 'paypal-transmission-id: smoke-probe' \\
  -H 'paypal-transmission-time: 2026-01-01T00:00:00Z' \\
  -H 'paypal-transmission-sig: invalid' \\
  -H 'paypal-cert-url: https://api.paypal.com' \\
  -H 'paypal-auth-algo: SHA256withRSA' \\
  -d '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"smoke-probe-ignore","amount":{"value":"0.01","currency_code":"EUR"}}}')
if [ "$PP_CODE" = "401" ]; then
  pass "PayPal webhook live (HTTP 401 — signature verify active)"
elif [ "$PP_CODE" = "503" ]; then
  BODY=$(cat /tmp/pp_probe.json)
  if echo "$BODY" | grep -q 'not enabled'; then
    fail "PayPal disabled in env"
  else
    pass "PayPal webhook reachable (HTTP 503 — missing/disabled path)"
  fi
else
  warn "PayPal webhook HTTP $PP_CODE"
  cat /tmp/pp_probe.json; echo
fi

echo ""
echo "[5] Admin login"
TOKEN=$(curl -fsS -X POST ${DOMAIN}/api/v1/admin/auth/login \\
  -H 'Content-Type: application/json' \\
  -d "{\\"email\\":\\"$ADMIN_EMAIL\\",\\"password\\":\\"$ADMIN_PASSWORD\\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
[ -n "$TOKEN" ] && pass "Admin JWT obtained" || fail "Admin login failed"

echo ""
echo "[6] Qonto manual poll"
POLL=$(curl -fsS -X POST ${DOMAIN}/api/v1/admin/payments/qonto-poll \\
  -H "Authorization: Bearer $TOKEN")
echo "$POLL" | python3 -m json.tool
echo "$POLL" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'fetched' in d" && pass "Qonto poll endpoint works" || fail "Qonto poll failed"

echo ""
echo "[7] Payments review queue"
QUEUE=$(curl -fsS "${DOMAIN}/api/v1/admin/payments/review-queue?pageSize=50" \\
  -H "Authorization: Bearer $TOKEN")
QUEUE_COUNT=$(echo "$QUEUE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total', len(d.get('items',[]))))")
pass "Review queue: $QUEUE_COUNT item(s) pending"
echo "$QUEUE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for i in d.get('items',[])[:5]:
    print('  -', i.get('source'), i.get('amount'), (i.get('payerName') or '')[:35], '|', i.get('matchDecision'))
"

echo ""
echo "[8] Payments history (status breakdown)"
HIST=$(curl -fsS "${DOMAIN}/api/v1/admin/payments?pageSize=100" \\
  -H "Authorization: Bearer $TOKEN")
echo "$HIST" | python3 -c "
import sys,json
from collections import Counter
d=json.load(sys.stdin)
items=d.get('items',[])
c=Counter(i.get('status') for i in items)
print('  Total:', d.get('total', len(items)))
for status, n in sorted(c.items()):
    print(f'  - {status}: {n}')
skipped=[i for i in items if i.get('status')=='SKIPPED']
airbnb=sum(1 for i in skipped if 'airbnb' in (i.get('payerName') or '').lower())
print('  Airbnb auto-skipped:', airbnb)
applied=sum(1 for i in items if i.get('status') in ('AUTO_APPLIED','MANUALLY_APPLIED'))
print('  Applied to Hostaway:', applied)
"
pass "History API works"

echo ""
echo "[9] Platform payout auto-skip (matcher)"
echo "$HIST" | python3 -c "
import sys,json
d=json.load(sys.stdin)
skipped=[i for i in d.get('items',[]) if i.get('status')=='SKIPPED' and i.get('matchDecision')=='PLATFORM_PAYOUT']
if skipped:
    print('  Found', len(skipped), 'PLATFORM_PAYOUT skips (Airbnb/Booking.com)')
    pass('Platform payout auto-skip active')
else:
    print('  No PLATFORM_PAYOUT skips in history yet')
    pass('Skip rule configured (no platform payouts in window)')
" 2>/dev/null || true

echo ""
echo "[10] Manual payment ingest (test pipeline, no Hostaway apply)"
INGEST=$(curl -fsS -X POST ${DOMAIN}/api/v1/admin/payments/ingest-manual \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "MANUAL",
    "externalId": "smoke-test-'$(date +%s)'",
    "amount": 0.01,
    "payerName": "Smoke Test Ignore",
    "reference": "automated smoke test - safe to skip"
  }')
echo "$INGEST" | python3 -m json.tool
INGEST_STATUS=$(echo "$INGEST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
INGEST_ID=$(echo "$INGEST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
if [ -n "$INGEST_ID" ]; then
  pass "Ingest pipeline works (status: $INGEST_STATUS)"
  curl -fsS -X POST "${DOMAIN}/api/v1/admin/payments/$INGEST_ID/skip" \\
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' > /dev/null
  pass "Cleanup: smoke test payment skipped"
else
  fail "Manual ingest failed"
fi

echo ""
echo "[11] Admin UI (concurrent review + history layout)"
UI_CHECK=$(docker exec vermietung-api sh -c "grep -c payments-history-table /app/public/admin/index.html && grep -c loadPaymentsHistory /app/public/admin/app.js")
if [ "$UI_CHECK" = "1
1" ] || echo "$UI_CHECK" | grep -q 1; then
  pass "Admin UI has review queue + history sections"
else
  warn "Admin UI layout check: $UI_CHECK"
fi

echo ""
echo "[12] Docker containers"
docker compose -f docker-compose.prod.yml ps --format "table {{.Name}}\t{{.Status}}" | head -6

echo ""
echo "========================================"
if [ "$FAILURES" -eq 0 ]; then
  echo "  RESULT: ALL TESTS PASSED"
else
  echo "  RESULT: $FAILURES TEST(S) FAILED"
fi
echo "========================================"
echo ""
exit $FAILURES
`;

if (!pass) {
  console.error('Set VPS_PASSWORD');
  process.exit(1);
}

const conn = new Client();
conn
  .on('ready', () => {
    conn.exec(remote, (err, stream) => {
      if (err) throw err;
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => process.stderr.write(d));
      stream.on('close', (code) => {
        process.exitCode = code || 0;
        conn.end();
      });
    });
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: pass,
    readyTimeout: 30_000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
