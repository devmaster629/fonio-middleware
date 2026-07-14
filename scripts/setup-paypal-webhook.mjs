#!/usr/bin/env node
/**
 * Register PayPal webhook via REST API and store PAYPAL_WEBHOOK_ID on VPS.
 * Uses PayPal API only — never calls the public webhook URL.
 */
import { Client } from 'ssh2';

const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = process.env.DEPLOY_APP_DIR ?? '/root/fonio-middleware';
const WEBHOOK_URL =
  process.env.PAYPAL_WEBHOOK_URL ??
  'https://vermietung.brainions.digital/webhooks/paypal';
const PAYPAL_MODE = process.env.PAYPAL_MODE ?? 'live';
const PAYPAL_CLIENT_ID =
  process.env.PAYPAL_CLIENT_ID ??
  'AUxiqcgIcdl4dHjdtIIvmwG3l0PFpxVNUs6EJbcssw_AyU7jk9fkgCBrcIrlGbCiigROgyfMSmIOVDJy';
const PAYPAL_CLIENT_SECRET =
  process.env.PAYPAL_CLIENT_SECRET ??
  'EO2TQQuIqhIrcP_cEeWnHtGKCi3heDGl1E_FcuEHtG8iM0SpCHqjttD57P90_IBikXgas_hqplTF8u0t';

const API_BASE =
  PAYPAL_MODE === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

const EVENT_TYPES = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'CHECKOUT.ORDER.APPROVED',
];

if (!VPS_PASS) {
  console.error('Set VPS_PASSWORD');
  process.exit(1);
}

async function paypalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString(
    'base64',
  );
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`PayPal OAuth failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function paypalGet(token, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`PayPal GET ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function paypalPost(token, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PayPal POST ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function ensureWebhook(token) {
  const list = await paypalGet(token, '/v1/notifications/webhooks');
  const existing = (list.webhooks ?? []).find((w) => w.url === WEBHOOK_URL);
  if (existing?.id) {
    console.log(`Found existing webhook: ${existing.id}`);
    return existing.id;
  }

  const created = await paypalPost(token, '/v1/notifications/webhooks', {
    url: WEBHOOK_URL,
    event_types: EVENT_TYPES.map((name) => ({ name })),
  });
  console.log(`Created webhook: ${created.id}`);
  return created.id;
}

function exec(conn, command, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`timeout: ${command}`));
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(stderr || `failed (${code})`));
        })
        .on('data', (d) => process.stdout.write(d.toString()))
        .stderr.on('data', (d) => {
          stderr += d.toString();
          process.stderr.write(d.toString());
        });
    });
  });
}

async function updateServerEnv(webhookId) {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on('ready', resolve)
      .on('error', reject)
      .connect({
        host: process.env.VPS_HOST ?? '85.214.41.33',
        port: 22,
        username: process.env.VPS_USER ?? 'root',
        password: VPS_PASS,
        readyTimeout: 30_000,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
        },
      });
  });

  try {
    const py = `
python3 - <<'PY'
from pathlib import Path
path = Path("${APP_DIR}/.env")
text = path.read_text()
updates = {
  "PAYPAL_ENABLED": "true",
  "PAYPAL_MODE": ${JSON.stringify(PAYPAL_MODE)},
  "PAYPAL_CLIENT_ID": ${JSON.stringify(PAYPAL_CLIENT_ID)},
  "PAYPAL_CLIENT_SECRET": ${JSON.stringify(PAYPAL_CLIENT_SECRET)},
  "PAYPAL_WEBHOOK_ID": ${JSON.stringify(webhookId)},
}
lines = text.splitlines()
seen = set()
out = []
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
print("PAYPAL_WEBHOOK_ID stored")
PY`;
    await exec(conn, `set -e\ncd ${APP_DIR}\n${py}`);
    await exec(
      conn,
      `cd ${APP_DIR} && docker compose -f docker-compose.prod.yml up -d api && sleep 20 && curl -fsS https://vermietung.brainions.digital/health`,
      180_000,
    );
  } finally {
    conn.end();
  }
}

try {
  console.log(`PayPal mode: ${PAYPAL_MODE}`);
  console.log(`Webhook URL (registered in PayPal, not probed): ${WEBHOOK_URL}`);
  const token = await paypalToken();
  const webhookId = await ensureWebhook(token);
  console.log(`Webhook ID: ${webhookId}`);
  await updateServerEnv(webhookId);
  console.log('Done');
} catch (error) {
  console.error('FAILED:', error.message);
  process.exit(1);
}
