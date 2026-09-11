#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

/** Push admin UI files to VPS host + running container (no full rebuild). */
import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { join } from 'path';

const pass = process.env.VPS_PASSWORD;
const APP_DIR = '/root/fonio-middleware';
const PORTAL_SVGS = [
  'agoda',
  'airbnb',
  'atraveo',
  'bookingcom',
  'check24',
  'direct',
  'expedia',
  'hometogo',
  'interhome',
  'travanto',
  'vrbo',
].map((name) => `public/admin/assets/portals/${name}.svg`);

const FILES = [
  'public/admin/app.js',
  'public/admin/index.html',
  'public/admin/i18n.js',
  'public/admin/styles.css',
  'public/admin/payment-plans.js',
  'public/admin/assets/check24-logo.png',
  'public/admin/assets/check24-logo-white.png',
  'public/admin/assets/check24-logo.svg',
  ...PORTAL_SVGS,
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

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function upload(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    stream.on('close', resolve);
    stream.on('error', reject);
    stream.end(content);
  });
}

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      await exec(
        conn,
        `mkdir -p ${APP_DIR}/public/admin/assets ${APP_DIR}/public/admin/assets/portals`,
      );
      const sftp = await openSftp(conn);
      for (const file of FILES) {
        const isBinary =
          file.endsWith('.png') ||
          file.endsWith('.jpg') ||
          file.endsWith('.webp');
        await upload(
          sftp,
          `${APP_DIR}/${file}`,
          readFileSync(join(process.cwd(), file), isBinary ? null : 'utf8'),
        );
        console.log('Uploaded', file);
      }
      sftp.end();
      const dockerFiles = FILES.join(' ');
      await exec(
        conn,
        `cd ${APP_DIR}
docker exec vermietung-api mkdir -p /app/public/admin/assets /app/public/admin/assets/portals
for f in ${dockerFiles}; do
  docker cp "$f" vermietung-api:/app/"$f"
done
docker exec vermietung-api grep -c check24-logo-white.png /app/public/admin/index.html
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
