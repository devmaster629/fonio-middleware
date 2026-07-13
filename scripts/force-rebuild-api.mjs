#!/usr/bin/env node
import { Client } from 'ssh2';

const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = '/root/fonio-middleware';

if (!VPS_PASS) process.exit(1);

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

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      await exec(
        conn,
        `set -e
cd ${APP_DIR}
# Ensure LF entrypoint
printf '%s\\n' '#!/bin/sh' 'set -e' '' 'echo "Running database migrations..."' 'npx prisma migrate deploy' '' 'echo "Starting API..."' 'exec "$@"' > scripts/docker-entrypoint.sh
sed -i 's/\\r$//' scripts/docker-entrypoint.sh
chmod +x scripts/docker-entrypoint.sh
# Upload path: make sure automation source is present
ls -la src/automation | head
# Force rebuild without cache
docker compose -f docker-compose.prod.yml build --no-cache api
docker compose -f docker-compose.prod.yml up -d api
sleep 35
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs api --tail 30
curl -fsS https://vermietung.brainions.digital/health
# Confirm Qonto env flags
grep -E '^(QONTO_|PAYPAL_)' .env | sed 's/=.*/=***/'
`,
      );
      console.log('OK');
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
    password: VPS_PASS,
    readyTimeout: 30000,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
