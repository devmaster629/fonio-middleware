#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

/** Push admin UI files to VPS host + running container (no full rebuild). */
import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { join } from 'path';

const pass = process.env.VPS_PASSWORD;
const APP_DIR = '/root/fonio-middleware';
const FILES = [
  'public/admin/app.js',
  'public/admin/index.html',
  'public/admin/i18n.js',
  'public/admin/styles.css',
];

function exec(conn, command, timeoutMs = 120_000) {
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
      for (const file of FILES) {
        await upload(conn, `${APP_DIR}/${file}`, readFileSync(join(process.cwd(), file), 'utf8'));
        console.log('Uploaded', file);
      }
      await exec(
        conn,
        `cd ${APP_DIR}
for f in public/admin/app.js public/admin/index.html public/admin/i18n.js public/admin/styles.css; do
  docker cp "$f" vermietung-api:/app/"$f"
done
docker exec vermietung-api grep -c payments-history-table /app/public/admin/index.html
curl -fsS https://vermietung.brainions.digital/health > /dev/null
echo LIVE_OK`,
      );
      console.log('DONE');
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: pass,
    readyTimeout: 30_000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
