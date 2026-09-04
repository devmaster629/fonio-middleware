import dotenv from 'dotenv';
dotenv.config();

import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { join } from 'path';

const pass = process.env.VPS_PASSWORD;
const localPath = join(process.cwd(), 'scripts', 'rematch-pending-once.cjs');
const content = readFileSync(localPath);

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

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      await new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err);
          sftp.writeFile(
            '/root/fonio-middleware/scripts/rematch-pending-once.cjs',
            content,
            (e) => (e ? reject(e) : resolve()),
          );
        });
      });
      await exec(
        conn,
        `docker cp /root/fonio-middleware/scripts/rematch-pending-once.cjs vermietung-api:/app/rematch-pending-once.cjs && docker exec -w /app vermietung-api node /app/rematch-pending-once.cjs`,
      );
      console.log('REMATCH_DONE');
    } catch (e) {
      console.error(e.message || e);
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
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
