#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import { Client } from 'ssh2';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { join } from 'path';

const pass = process.env.VPS_PASSWORD;
const ARCHIVE = join(process.cwd(), 'portal-payment-fix.tgz');
const APP_DIR = '/root/fonio-middleware';

if (!pass) {
  console.error('VPS_PASSWORD missing');
  process.exit(1);
}

execSync(
  'tar -czf portal-payment-fix.tgz package.json package-lock.json src prisma public',
  { stdio: 'inherit' },
);

function exec(conn, command, timeoutMs = 1_200_000) {
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
      await upload(conn, ARCHIVE, '/tmp/portal-payment-fix.tgz');
      console.log('Uploaded');
      await exec(
        conn,
        `set -e
cd ${APP_DIR}
tar -xzf /tmp/portal-payment-fix.tgz -C ${APP_DIR}
rm -f /tmp/portal-payment-fix.tgz
docker compose -f docker-compose.prod.yml build api
docker compose -f docker-compose.prod.yml up -d api
sleep 25
curl -fsS https://vermietung.brainions.digital/health
echo
echo DEPLOY_OK`,
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
    password: pass,
    readyTimeout: 30_000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
