#!/usr/bin/env node
/**
 * Configure Qonto + PayPal on VPS from provided credentials,
 * create Qonto webhook subscription, enable integrations, restart API.
 */
import { Client } from 'ssh2';
import { randomBytes } from 'crypto';

const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = '/root/fonio-middleware';
const DOMAIN = 'vermietung.brainions.digital';

// From client RTF files
const QONTO_LOGIN = 'brainions-gmbh-3610';
const QONTO_SECRET = '4591991aead2211d3d730841428e1c7b';
const PAYPAL_CLIENT_ID =
  'AUxiqcgIcdl4dHjdtIIvmwG3l0PFpxVNUs6EJbcssw_AyU7jk9fkgCBrcIrlGbCiigROgyfMSmIOVDJy';
const PAYPAL_CLIENT_SECRET =
  'EO2TQQuIqhIrcP_cEeWnHtGKCi3heDGl1E_FcuEHtG8iM0SpCHqjttD57P90_IBikXgas_hqplTF8u0t';

const QONTO_WEBHOOK_SECRET =
  process.env.QONTO_WEBHOOK_SECRET ||
  `whsec_${randomBytes(32).toString('base64url')}`;

if (!VPS_PASS) {
  console.error('Set VPS_PASSWORD');
  process.exit(1);
}

function exec(conn, command, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`timeout: ${command}`));
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve({ stdout, stderr });
          else
            reject(
              new Error(
                `failed (${code}): ${command}\n${stderr || stdout}`,
              ),
            );
        })
        .on('data', (d) => {
          const t = d.toString();
          stdout += t;
          process.stdout.write(t);
        })
        .stderr.on('data', (d) => {
          const t = d.toString();
          stderr += t;
          process.stderr.write(t);
        });
    });
  });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      console.log('\n=== Update .env credentials ===\n');
      const upsertEnv = `
set -e
cd ${APP_DIR}
cp .env .env.bak.payments.$(date +%s)

python3 - <<'PY'
from pathlib import Path
path = Path("${APP_DIR}/.env")
text = path.read_text()
updates = {
  "QONTO_ENABLED": "true",
  "QONTO_CLIENT_ID": ${JSON.stringify(QONTO_LOGIN)},
  "QONTO_CLIENT_SECRET": ${JSON.stringify(QONTO_SECRET)},
  "QONTO_LOGIN": ${JSON.stringify(QONTO_LOGIN)},
  "QONTO_SECRET_KEY": ${JSON.stringify(QONTO_SECRET)},
  "QONTO_ORGANIZATION_SLUG": "brainions-gmbh",
  "QONTO_WEBHOOK_SECRET": ${JSON.stringify(QONTO_WEBHOOK_SECRET)},
  "PAYPAL_ENABLED": "true",
  "PAYPAL_CLIENT_ID": ${JSON.stringify(PAYPAL_CLIENT_ID)},
  "PAYPAL_CLIENT_SECRET": ${JSON.stringify(PAYPAL_CLIENT_SECRET)},
  "PAYPAL_MODE": "live",
}
lines = text.splitlines()
keys = set(updates)
out = []
seen = set()
for line in lines:
  if not line or line.startswith("#") or "=" not in line:
    out.append(line)
    continue
  k = line.split("=", 1)[0]
  if k in updates:
    out.append(f"{k}={updates[k]}")
    seen.add(k)
  else:
    out.append(line)
for k, v in updates.items():
  if k not in seen:
    out.append(f"{k}={v}")
path.write_text("\\n".join(out) + "\\n")
print("env updated")
PY
`;
      await exec(conn, upsertEnv);

      console.log('\n=== Verify Qonto API auth ===\n');
      await exec(
        conn,
        `curl -fsS -H ${shellEscape(`Authorization: ${QONTO_LOGIN}:${QONTO_SECRET}`)} https://thirdparty.qonto.com/v2/organization | python3 -c "import sys,json; d=json.load(sys.stdin); o=d.get('organization') or d; print('org=', o.get('slug') or o.get('name') or o.get('legal_name') or list(o.keys())[:8])"`,
      );

      console.log('\n=== List existing Qonto webhooks ===\n');
      await exec(
        conn,
        `curl -fsS -H ${shellEscape(`Authorization: ${QONTO_LOGIN}:${QONTO_SECRET}`)} https://thirdparty.qonto.com/v2/webhook_subscriptions | python3 -m json.tool || true`,
      );

      console.log('\n=== Create Qonto transaction webhook ===\n');
      const createBody = JSON.stringify({
        callback_url: `https://${DOMAIN}/webhooks/qonto`,
        types: ['v1/transactions'],
        secret: QONTO_WEBHOOK_SECRET,
        description: 'brainions vermietung payment reconciliation',
      });
      try {
        await exec(
          conn,
          `curl -fsS -X POST https://thirdparty.qonto.com/v2/webhook_subscriptions \\
  -H ${shellEscape(`Authorization: ${QONTO_LOGIN}:${QONTO_SECRET}`)} \\
  -H 'Content-Type: application/json' \\
  -d ${shellEscape(createBody)} | python3 -m json.tool`,
        );
      } catch (e) {
        console.error(
          '\nWebhook create failed (may already exist or need OAuth). Continuing...\n',
          e.message,
        );
      }

      console.log('\n=== Restart API to load new env ===\n');
      await exec(
        conn,
        `cd ${APP_DIR} && docker compose -f docker-compose.prod.yml up -d api && sleep 25 && docker compose -f docker-compose.prod.yml ps && curl -fsS https://${DOMAIN}/health && docker compose -f docker-compose.prod.yml logs api --tail 20`,
        180_000,
      );

      console.log('\n=== Probe webhook endpoints ===\n');
      await exec(
        conn,
        `curl -s -o /tmp/qonto_probe.json -w "qonto_http=%{http_code}\\n" -X POST https://${DOMAIN}/webhooks/qonto -H 'Content-Type: application/json' -d '{"transaction":{"id":"probe-manual-ignore","amount":1,"currency":"EUR","label":"probe","settled_at":"2026-07-13T12:00:00Z"}}'
cat /tmp/qonto_probe.json; echo
curl -s -o /tmp/paypal_probe.json -w "paypal_http=%{http_code}\\n" -X POST https://${DOMAIN}/webhooks/paypal -H 'Content-Type: application/json' -H 'paypal-transmission-id: probe' -d '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"probe-manual-ignore","amount":{"value":"1.00","currency_code":"EUR"},"create_time":"2026-07-13T12:00:00Z"}}'
cat /tmp/paypal_probe.json; echo`,
      );

      console.log('\n=== Done ===\n');
      console.log('Qonto webhook secret stored in server .env as QONTO_WEBHOOK_SECRET');
      console.log('PayPal: waiting for client webhook ID once they register the URL');
    } catch (error) {
      console.error('\nFAILED:', error.message);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .on('error', (err) => {
    console.error('SSH error:', err.message);
    process.exit(1);
  })
  .connect({
    host: '85.214.41.33',
    port: 22,
    username: 'root',
    password: VPS_PASS,
    readyTimeout: 30_000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
