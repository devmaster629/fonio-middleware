#!/usr/bin/env node
import { Client } from 'ssh2';

const pass = process.env.VPS_PASSWORD;
const remote = `
cd /root/fonio-middleware
docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung -c "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 3;"
docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung -c "SELECT COUNT(*) AS total, COUNT(\\"totalPrice\\") AS with_price FROM \\"Reservation\\";"
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
