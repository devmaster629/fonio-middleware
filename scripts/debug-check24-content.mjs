import { Client } from 'ssh2';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const VPS_HOST = process.env.VPS_HOST || process.env.VPS_IP_ADDRESS;
const VPS_USER = process.env.VPS_USER || process.env.VPS_USERNAME || 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const DOMAIN = 'vermietung.brainions.digital';
const hostawayId = process.argv[2] || '172749';

function httpJson(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(`https://${DOMAIN}${path}`);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(d);
          } catch {
            json = d;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream
        .on('close', (code) => resolve({ code, out }))
        .on('data', (d) => (out += d.toString()))
        .stderr.on('data', (d) => (out += d.toString()));
    });
  });
}

const login = await httpJson('POST', '/api/v1/admin/auth/login', {
  body: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
});
const token = login.json.accessToken;
const preview = await httpJson(
  'GET',
  `/api/v1/admin/check24/preview/${hostawayId}`,
  { token },
);
console.log('preview status', preview.status);
console.log(JSON.stringify(preview.json, null, 2).slice(0, 4000));

// Push content and then grab logs
await httpJson('POST', `/api/v1/admin/check24/sync/${hostawayId}/content`, {
  token,
});

const conn = new Client();
conn
  .on('ready', async () => {
    const logs = await exec(
      conn,
      `cd /root/fonio-middleware && docker compose -f docker-compose.prod.yml logs api --tail 80`,
    );
    console.log('\n=== API LOGS ===\n' + logs.out);
    conn.end();
  })
  .connect({
    host: VPS_HOST,
    username: VPS_USER,
    password: VPS_PASS,
    readyTimeout: 30000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
