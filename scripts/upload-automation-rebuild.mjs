#!/usr/bin/env node
import { Client } from 'ssh2';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { join } from 'path';

const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = '/root/fonio-middleware';
const ARCHIVE = join(process.cwd(), 'automation-upload.tgz');

if (!VPS_PASS) process.exit(1);

execSync(
  'tar -czf automation-upload.tgz package.json package-lock.json src/automation src/hostaway/hostaway.types.ts src/hostaway/hostaway-sync.service.ts src/webhooks/qonto-webhook.controller.ts src/webhooks/paypal-webhook.controller.ts src/webhooks/webhooks.module.ts src/app.module.ts prisma/schema.prisma prisma/migrations public/admin/app.js public/admin/index.html public/admin/i18n.js .env.example',
  { stdio: 'inherit' },
);

function exec(conn, command, timeoutMs = 1_800_000) {
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

function upload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
  });
}

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      console.log('Uploading archive...');
      await upload(conn, ARCHIVE, '/tmp/automation-upload.tgz');
      await exec(
        conn,
        `set -e
cd ${APP_DIR}
tar -xzf /tmp/automation-upload.tgz -C ${APP_DIR}
rm -f /tmp/automation-upload.tgz
ls src/automation
printf '%s\\n' '#!/bin/sh' 'set -e' '' 'echo "Running database migrations..."' 'npx prisma migrate deploy' '' 'echo "Starting API..."' 'exec "$@"' > scripts/docker-entrypoint.sh
sed -i 's/\\r$//' scripts/docker-entrypoint.sh
chmod +x scripts/docker-entrypoint.sh
docker compose -f docker-compose.prod.yml build --no-cache api
docker compose -f docker-compose.prod.yml up -d api
sleep 30
curl -fsS https://vermietung.brainions.digital/health
docker compose -f docker-compose.prod.yml logs api --tail 25`,
      );
      console.log('DONE');
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      try {
        unlinkSync(ARCHIVE);
      } catch {}
      conn.end();
    }
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: VPS_PASS,
    readyTimeout: 30000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
