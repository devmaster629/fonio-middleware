#!/usr/bin/env node
import { Client } from 'ssh2';

const pass = process.env.VPS_PASSWORD;
const remote = `
set -a
source /root/fonio-middleware/.env
set +a
TOKEN=$(curl -fsS -X POST https://vermietung.brainions.digital/api/v1/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\\"email\\":\\"$ADMIN_EMAIL\\",\\"password\\":\\"$ADMIN_PASSWORD\\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
echo "TOKEN_OK"
curl -fsS -X POST https://vermietung.brainions.digital/api/v1/admin/sync \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool
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
