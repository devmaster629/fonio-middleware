#!/usr/bin/env node
/**
 * Deploy guestPictureUrl + requests UI polish.
 * Usage: node scripts/deploy-guest-picture.mjs
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const pass = process.env.VPS_PASSWORD;
const APP_DIR = '/root/fonio-middleware';
const HOST = '85.214.41.33';

const FILES = [
  'prisma/schema.prisma',
  'prisma/migrations/20260910140000_reservation_guest_picture/migration.sql',
  'src/hostaway/hostaway.types.ts',
  'src/hostaway/hostaway-sync.service.ts',
  'public/admin/index.html',
  'public/admin/app.js',
  'public/admin/styles.css',
  'public/admin/i18n.js',
];

if (!pass) {
  console.error('VPS_PASSWORD not set');
  process.exit(1);
}

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

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      await exec(
        conn,
        `mkdir -p ${APP_DIR}/prisma/migrations/20260910140000_reservation_guest_picture`,
      );
      for (const file of FILES) {
        const local = join(process.cwd(), file);
        if (!existsSync(local)) throw new Error(`Missing: ${file}`);
        await upload(conn, `${APP_DIR}/${file}`, readFileSync(local));
        console.log('Uploaded', file);
      }
      await exec(
        conn,
        `set -e
cd ${APP_DIR}
docker compose -f docker-compose.prod.yml up -d --build api
sleep 25
for f in public/admin/app.js public/admin/index.html public/admin/i18n.js public/admin/styles.css; do
  docker cp "$f" vermietung-api:/app/"$f" || true
done
curl -fsS https://vermietung.brainions.digital/health
echo
echo LIVE_OK`,
      );
      console.log('DONE');
    } catch (e) {
      console.error(e.message || e);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .connect({
    host: HOST,
    username: 'root',
    password: pass,
    readyTimeout: 30000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
