#!/usr/bin/env node
/**
 * Add PAYMENT_PLATFORM_PAYOUT_SENDERS to server .env, restart API,
 * then re-run matching on pending review payments so Airbnb payouts
 * get auto-skipped out of the queue.
 */
import { Client } from 'ssh2';

const pass = process.env.VPS_PASSWORD;
const remote = `
set -e
cd /root/fonio-middleware
sed -i "s|^PAYMENT_PLATFORM_PAYOUT_SENDERS=.*|PAYMENT_PLATFORM_PAYOUT_SENDERS=airbnb|" .env
grep -q '^PAYMENT_PLATFORM_PAYOUT_SENDERS=' .env || echo "PAYMENT_PLATFORM_PAYOUT_SENDERS=airbnb" >> .env
docker compose -f docker-compose.prod.yml up -d api
sleep 25
curl -fsS https://vermietung.brainions.digital/health > /dev/null
echo "API_OK"

set -a
source .env
set +a
TOKEN=$(curl -fsS -X POST https://vermietung.brainions.digital/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\\"email\\":\\"$ADMIN_EMAIL\\",\\"password\\":\\"$ADMIN_PASSWORD\\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
echo "TOKEN_OK"

IDS=$(curl -fsS "https://vermietung.brainions.digital/api/v1/admin/payments/review-queue?pageSize=100" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for i in d.get('items', []):
    print(i['id'])")

for id in $IDS; do
  echo "retry $id"
  curl -fsS -X POST "https://vermietung.brainions.digital/api/v1/admin/payments/$id/retry" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(' ->', d.get('status'))"
done

echo "--- final queue ---"
curl -fsS "https://vermietung.brainions.digital/api/v1/admin/payments/review-queue?pageSize=100" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d.get('items', [])
print('pending:', len(items))
for i in items:
    print(i.get('source'), i.get('amount'), (i.get('payerName') or '')[:40])"
`;

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
    readyTimeout: 30000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
