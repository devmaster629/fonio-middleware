#!/usr/bin/env node
import { Client } from 'ssh2';

const pass = process.env.VPS_PASSWORD;
const auth = 'brainions-gmbh-3610:4591991aead2211d3d730841428e1c7b';

const remote = `
set -e
AUTH='${auth}'
curl -fsS -H "Authorization: $AUTH" https://thirdparty.qonto.com/v2/organization > /tmp/qonto_org.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/qonto_org.json'))
o=d.get('organization') or d
print('slug', o.get('slug'))
accounts=o.get('bank_accounts') or []
print('accounts', len(accounts))
for a in accounts:
  print('id=', a.get('id'), 'slug=', a.get('slug'), 'iban=', a.get('iban'), 'ccy=', a.get('currency'))
open('/tmp/qonto_accounts.json','w').write(json.dumps(accounts))
PY
ID=$(python3 -c "import json; a=json.load(open('/tmp/qonto_accounts.json')); print(a[0]['id'] if a else '')")
echo ACCOUNT_ID=$ID
if [ -n "$ID" ]; then
  curl -fsS -G -H "Authorization: $AUTH" \
    --data-urlencode "bank_account_id=$ID" \
    --data-urlencode "side=credit" \
    --data-urlencode "per_page=5" \
    https://thirdparty.qonto.com/v2/transactions > /tmp/qonto_tx.json
  python3 -m json.tool /tmp/qonto_tx.json | head -120
fi
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
