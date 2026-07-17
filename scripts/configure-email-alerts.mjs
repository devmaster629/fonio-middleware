#!/usr/bin/env node
/**
 * Configure payment alert SMTP on VPS + Hostaway webhook alert email.
 * Usage:
 *   SMTP_PASS='...' VPS_PASSWORD='...' node scripts/configure-email-alerts.mjs
 * Optional: SMTP_TEST=true to send a test email after deploy.
 */
import { Client } from 'ssh2';
import 'dotenv/config';

const VPS_PASS = process.env.VPS_PASSWORD;
const SMTP_PASS = process.env.SMTP_PASS;
const APP_DIR = '/root/fonio-middleware';
const WEBHOOK_URL = 'https://vermietung.brainions.digital/webhooks/hostaway';

const CONFIG = {
  paymentAlertsEnabled: 'true',
  paymentAlertTo: 'vermietung@brainions.de',
  paymentAlertFrom: 'technik@ichweissdas.net',
  smtpHost: 'send.one.com',
  smtpPort: '587',
  smtpSecure: 'false',
  smtpUser: 'technik@ichweissdas.net',
  webhookAlertEmail: 'technik@brainions.de',
};

if (!VPS_PASS || !SMTP_PASS) {
  console.error('Set VPS_PASSWORD and SMTP_PASS');
  process.exit(1);
}

function exec(conn, command, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error('timeout'));
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error(`failed ${code}`));
        })
        .on('data', (d) => process.stdout.write(d.toString()))
        .stderr.on('data', (d) => process.stderr.write(d.toString()));
    });
  });
}

async function updateHostawayWebhookAlertEmail() {
  const accountId = process.env.HOSTAWAY_ACCOUNT_ID;
  const apiSecret = process.env.HOSTAWAY_API_SECRET;
  const base = (
    process.env.HOSTAWAY_API_BASE_URL ?? 'https://api.hostaway.com/v1'
  ).replace(/\/$/, '');
  if (!accountId || !apiSecret) {
    throw new Error('HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_SECRET required in local .env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: accountId,
    client_secret: apiSecret,
    scope: 'general',
  });
  const tokenRes = await fetch(`${base}/accessTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Hostaway token failed: ${JSON.stringify(tokenData)}`);
  }
  const token = tokenData.access_token;

  const listRes = await fetch(`${base}/webhooks/unifiedWebhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json();
  const hook = (listData.result || []).find((w) => w.url === WEBHOOK_URL);
  if (!hook) throw new Error(`Webhook not found: ${WEBHOOK_URL}`);

  const putRes = await fetch(`${base}/webhooks/unifiedWebhooks/${hook.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      isEnabled: hook.isEnabled ?? 1,
      url: hook.url,
      login: hook.login,
      password: hook.password,
      alertingEmailAddress: CONFIG.webhookAlertEmail,
    }),
  });
  const putData = await putRes.json();
  if (!putRes.ok) {
    throw new Error(`Hostaway webhook update failed: ${JSON.stringify(putData)}`);
  }
  console.log(
    `Hostaway webhook #${hook.id} alert email -> ${putData.result?.alertingEmailAddress}`,
  );
}

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      console.log('Updating server .env...');
      const envScript = `python3 - <<'PY'
from pathlib import Path
path = Path('${APP_DIR}/.env')
text = path.read_text()
updates = {
  'PAYMENT_ALERTS_ENABLED': '${CONFIG.paymentAlertsEnabled}',
  'PAYMENT_ALERT_TO': '${CONFIG.paymentAlertTo}',
  'PAYMENT_ALERT_FROM': '${CONFIG.paymentAlertFrom}',
  'PAYMENT_ALERT_SMTP_HOST': '${CONFIG.smtpHost}',
  'PAYMENT_ALERT_SMTP_PORT': '${CONFIG.smtpPort}',
  'PAYMENT_ALERT_SMTP_SECURE': '${CONFIG.smtpSecure}',
  'PAYMENT_ALERT_SMTP_USER': '${CONFIG.smtpUser}',
  'PAYMENT_ALERT_SMTP_PASS': ${JSON.stringify(SMTP_PASS)},
}
lines = text.splitlines()
seen = set()
out = []
for line in lines:
  if not line or line.startswith('#') or '=' not in line:
    out.append(line)
    continue
  k = line.split('=', 1)[0]
  if k in updates:
    out.append(f"{k}={updates[k]}")
    seen.add(k)
  else:
    out.append(line)
for k, v in updates.items():
  if k not in seen:
    out.append(f"{k}={v}")
path.write_text('\\n'.join(out) + '\\n')
print('env updated')
PY`;
      await exec(conn, envScript);

      console.log('Restarting API...');
      await exec(
        conn,
        `cd ${APP_DIR} && docker compose -f docker-compose.prod.yml up -d api && sleep 20 && curl -fsS https://vermietung.brainions.digital/health`,
      );

      console.log('Updating Hostaway webhook alert email...');
      await updateHostawayWebhookAlertEmail();

      if (process.env.SMTP_TEST === 'true') {
        console.log('Sending SMTP test email (using container env)...');
        const testScript = `docker exec vermietung-api node -e "const n=require('nodemailer');(async()=>{const t=n.createTransport({host:process.env.PAYMENT_ALERT_SMTP_HOST,port:Number(process.env.PAYMENT_ALERT_SMTP_PORT||587),secure:process.env.PAYMENT_ALERT_SMTP_SECURE==='true',auth:{user:process.env.PAYMENT_ALERT_SMTP_USER,pass:process.env.PAYMENT_ALERT_SMTP_PASS}});await t.sendMail({from:process.env.PAYMENT_ALERT_FROM,to:process.env.PAYMENT_ALERT_TO,subject:'[Hostaway Payments] SMTP test',text:'Payment alert SMTP is configured and working.'});console.log('SMTP_TEST_OK');})().catch(e=>{console.error('SMTP_TEST_FAIL',e.message);process.exit(1)});"`;
        await exec(conn, testScript);
      }

      console.log('DONE');
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .connect({
    host: '85.214.41.33',
    port: 22,
    username: 'root',
    password: VPS_PASS,
  });
