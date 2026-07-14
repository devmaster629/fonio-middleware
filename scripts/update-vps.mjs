#!/usr/bin/env node
/**
 * Pull latest code on VPS and rebuild containers (keeps existing .env).
 * Usage: VPS_PASSWORD='...' node scripts/update-vps.mjs
 */
import { Client } from 'ssh2';

const VPS_HOST = process.env.VPS_HOST ?? '85.214.41.33';
const VPS_USER = process.env.VPS_USER ?? 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = process.env.DEPLOY_APP_DIR ?? '/root/fonio-middleware';
const DOMAIN = process.env.DOMAIN ?? 'vermietung.brainions.digital';
const REPO_URL =
  process.env.DEPLOY_REPO_URL ??
  'https://github.com/devmaster629/fonio-middleware.git';

if (!VPS_PASS) {
  console.error('ERROR: Set VPS_PASSWORD environment variable');
  process.exit(1);
}

function exec(conn, command, timeoutMs = 1_800_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Command timed out: ${command}`));
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`Command failed (${code}): ${command}\n${stderr || stdout}`));
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

const conn = new Client();

conn
  .on('ready', async () => {
    try {
      console.log('\n=== VPS update started ===\n');

      await exec(
        conn,
        `cd "${APP_DIR}" && git remote set-url origin "${REPO_URL}" && git fetch origin && git pull origin master`,
        300_000,
      );

      await exec(
        conn,
        `cd "${APP_DIR}" && docker compose -f docker-compose.prod.yml up -d --build`,
        1_800_000,
      );

      await exec(
        conn,
        `sleep 25
cd "${APP_DIR}"
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs api --tail 30
curl -fsS https://${DOMAIN}/health || true`,
        120_000,
      );

      console.log('\n=== Update finished ===\n');
      console.log(`Admin: https://${DOMAIN}/admin`);
      console.log('Sign out and sign in again to refresh your role (SUPER_ADMIN).');
    } catch (error) {
      console.error('\nUPDATE FAILED:', error.message);
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
