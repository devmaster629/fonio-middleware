#!/usr/bin/env node
import { Client } from 'ssh2';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const pass = process.env.VPS_PASSWORD;
const tmpDist = join(process.cwd(), 'payment-alert.service.js.tmp');
const tmpSrc = join(process.cwd(), 'payment-alert.service.ts.tmp');

function upload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
  });
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

if (!pass) {
  console.error('Set VPS_PASSWORD');
  process.exit(1);
}

writeFileSync(
  tmpDist,
  readFileSync(join(process.cwd(), 'dist', 'automation', 'payment-alert.service.js')),
);
writeFileSync(
  tmpSrc,
  readFileSync(join(process.cwd(), 'src', 'automation', 'payment-alert.service.ts')),
);

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      await upload(conn, tmpDist, '/tmp/payment-alert.service.js');
      await upload(conn, tmpSrc, '/tmp/payment-alert.service.ts');
      await exec(
        conn,
        `set -e
docker cp /tmp/payment-alert.service.js vermietung-api:/app/dist/automation/payment-alert.service.js
cp /tmp/payment-alert.service.ts /root/fonio-middleware/src/automation/payment-alert.service.ts
docker restart vermietung-api
sleep 20
curl -fsS https://vermietung.brainions.digital/health
echo HOTFIX_OK`,
      );
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      try {
        unlinkSync(tmpDist);
        unlinkSync(tmpSrc);
      } catch {}
      conn.end();
    }
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: pass,
    readyTimeout: 30000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
