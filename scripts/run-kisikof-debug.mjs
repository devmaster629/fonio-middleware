#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import { Client } from 'ssh2';
import { readFileSync } from 'fs';

const pass = process.env.VPS_PASSWORD;
const conn = new Client();

function exec(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error('timeout'));
      }, timeoutMs);
      stream.on('data', (d) => {
        out += d.toString();
      });
      stream.stderr.on('data', (d) => {
        out += d.toString();
      });
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
  });
}

conn
  .on('ready', async () => {
    try {
      const sftp = await new Promise((res, rej) =>
        conn.sftp((e, s) => (e ? rej(e) : res(s))),
      );
      await new Promise((res, rej) => {
        const ws = sftp.createWriteStream('/tmp/debug-kisikof.cjs');
        ws.on('close', res);
        ws.on('error', rej);
        ws.end(readFileSync('scripts/debug-kisikof-payment.cjs'));
      });
      sftp.end();
      const out = await exec(
        'docker cp /tmp/debug-kisikof.cjs vermietung-api:/app/debug-kisikof.cjs && docker exec -w /app vermietung-api node /app/debug-kisikof.cjs',
      );
      console.log(out);
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: pass,
    readyTimeout: 30000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
