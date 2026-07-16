#!/usr/bin/env node
import { Client } from 'ssh2';

const pass = process.env.VPS_PASSWORD;
const remote = `
set -e
cd /root/fonio-middleware
docker exec vermietung-api node -e "require('nodemailer'); console.log('NODEMAILER_OK')"
docker exec vermietung-api sh -c "test -f /app/dist/automation/payment-alert.service.js && echo ALERT_FILE_OK"
`;

const conn = new Client();
conn
  .on('ready', () => {
    conn.exec(remote, (err, stream) => {
      if (err) throw err;
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => process.stderr.write(d));
      stream.on('close', (code) => {
        process.exitCode = code || 0;
        conn.end();
      });
    });
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: pass,
    readyTimeout: 30000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
