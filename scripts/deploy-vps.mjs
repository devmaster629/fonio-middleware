#!/usr/bin/env node
/**
 * One-time VPS deployment helper (SSH + Docker Compose).
 * Usage: VPS_PASSWORD='...' node scripts/deploy-vps.mjs
 */
import { Client } from 'ssh2';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const VPS_HOST = process.env.VPS_HOST ?? '85.214.41.33';
const VPS_USER = process.env.VPS_USER ?? 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const REPO_URL =
  process.env.DEPLOY_REPO_URL ??
  'https://github.com/devmaster629/fonio-middleware.git';
const APP_DIR = process.env.DEPLOY_APP_DIR ?? '/root/fonio-middleware';
const DOMAIN = 'vermietung.brainions.digital';

if (!VPS_PASS) {
  console.error('ERROR: Set VPS_PASSWORD environment variable');
  process.exit(1);
}

function randHex(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function parseEnvFile(content) {
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    env[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
  return env;
}

function buildProductionEnv(local) {
  const postgresPassword = randHex(24);
  const jwtSecret = randHex(32);
  const webhookUser = 'vermietung-webhook';
  const webhookPass = randHex(16);

  const lines = [
    'NODE_ENV=production',
    'PORT=3000',
    `DOMAIN=${DOMAIN}`,
    `APP_URL=https://${DOMAIN}`,
    `PRODUCTION_URL=https://${DOMAIN}`,
    '',
    'POSTGRES_USER=vermietung',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    'POSTGRES_DB=vermietung',
    '',
    `HOSTAWAY_ACCOUNT_ID=${local.HOSTAWAY_ACCOUNT_ID}`,
    `HOSTAWAY_API_SECRET=${local.HOSTAWAY_API_SECRET}`,
    `HOSTAWAY_API_BASE_URL=${local.HOSTAWAY_API_BASE_URL ?? 'https://api.hostaway.com/v1'}`,
    '',
    `FONIO_API_KEY=${local.FONIO_API_KEY}`,
    '',
    `JWT_SECRET=${jwtSecret}`,
    `JWT_EXPIRES_IN=${local.JWT_EXPIRES_IN ?? '8h'}`,
    `ADMIN_EMAIL=${local.ADMIN_EMAIL}`,
    `ADMIN_PASSWORD=${local.ADMIN_PASSWORD}`,
    '',
    'LOG_RETENTION_DEBUG_DAYS=14',
    'LOG_RETENTION_OPERATIONAL_DAYS=30',
    'LOG_RETENTION_PII_DAYS=30',
    'LOG_RETENTION_MAX_DAYS=90',
    '',
    'SYNC_ENABLED=true',
    'SYNC_INTERVAL_MINUTES=30',
    '',
    `HOSTAWAY_WEBHOOK_USERNAME=${webhookUser}`,
    `HOSTAWAY_WEBHOOK_PASSWORD=${webhookPass}`,
    '',
    'FORCE_HTTPS=true',
    '',
    'CONVERSATION_BACKFILL_ON_SYNC=true',
  ];

  return {
    content: `${lines.join('\n')}\n`,
    secrets: { postgresPassword, jwtSecret, webhookUser, webhookPass },
  };
}

function exec(conn, command, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve({ stdout, stderr });
          else
            reject(
              new Error(
                `Command failed (${code}): ${command}\n${stderr || stdout}`,
              ),
            );
        })
        .on('data', (d) => {
          const text = d.toString();
          stdout += text;
          process.stdout.write(text);
        })
        .stderr.on('data', (d) => {
          const text = d.toString();
          stderr += text;
          process.stderr.write(text);
        });
    });
  });
}

function upload(conn, remotePath, content) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', resolve);
      stream.on('error', reject);
      stream.end(content);
    });
  });
}

const localEnv = parseEnvFile(readFileSync(join(ROOT, '.env'), 'utf8'));
const { content: prodEnv, secrets } = buildProductionEnv(localEnv);

const conn = new Client();

conn
  .on('ready', async () => {
    try {
      console.log('\n=== VPS deployment started ===\n');

      await exec(
        conn,
        `export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl git ufw
  curl -fsSL https://get.docker.com | sh
fi
docker --version
docker compose version`,
        900_000,
      );

      await exec(
        conn,
        `if [ -d "${APP_DIR}/.git" ]; then
  cd "${APP_DIR}" && git pull origin master
else
  rm -rf "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
fi`,
        300_000,
      );

      await upload(conn, `${APP_DIR}/.env`, prodEnv);
      console.log('\nUploaded production .env\n');

      await exec(
        conn,
        `ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
echo y | ufw enable || true
cd "${APP_DIR}"
docker compose -f docker-compose.prod.yml up -d --build`,
        1_800_000,
      );

      await exec(
        conn,
        `sleep 20
cd "${APP_DIR}"
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.error(e);process.exit(1)})"
curl -fsS https://${DOMAIN}/health || true`,
        120_000,
      );

      console.log('\n=== Deployment finished ===\n');
      console.log('URLs:');
      console.log(`  Admin:  https://${DOMAIN}/admin`);
      console.log(`  Health: https://${DOMAIN}/health`);
      console.log(`  Docs:   https://${DOMAIN}/docs`);
      console.log('\nAdmin login:');
      console.log(`  Email:    ${localEnv.ADMIN_EMAIL}`);
      console.log(`  Password: (same as local .env ADMIN_PASSWORD)`);
      console.log('\nGenerated on server (.env) — save these securely:');
      console.log(`  POSTGRES_PASSWORD=${secrets.postgresPassword}`);
      console.log(`  JWT_SECRET=${secrets.jwtSecret}`);
      console.log(`  WEBHOOK_USER=${secrets.webhookUser}`);
      console.log(`  WEBHOOK_PASS=${secrets.webhookPass}`);
      console.log('\nNext steps:');
      console.log('  1. Open admin → Hostaway Sync (wait for completion)');
      console.log('  2. Set auto sync to 30 minutes');
      console.log('  3. Register Hostaway webhook');
      console.log('  4. Configure fonio with production URLs + FONIO_API_KEY');
      console.log('  5. Change VPS root password and admin password');
    } catch (error) {
      console.error('\nDEPLOY FAILED:', error.message);
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
    host: VPS_HOST,
    port: 22,
    username: VPS_USER,
    password: VPS_PASS,
    readyTimeout: 30_000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
