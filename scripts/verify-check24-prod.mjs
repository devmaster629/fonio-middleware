import { Client } from 'ssh2';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const VPS_HOST = process.env.VPS_HOST || process.env.VPS_IP_ADDRESS || '85.214.41.33';
const VPS_USER = process.env.VPS_USER || process.env.VPS_USERNAME || 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = process.env.DEPLOY_APP_DIR || '/root/fonio-middleware';
const DOMAIN = 'vermietung.brainions.digital';

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream
        .on('close', (code) =>
          code === 0 ? resolve(out) : reject(new Error(`${code}\n${out}`)),
        )
        .on('data', (d) => (out += d.toString()))
        .stderr.on('data', (d) => (out += d.toString()));
    });
  });
}

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

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      const tables = await exec(
        conn,
        `cd ${APP_DIR} && docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ILIKE 'check24%' ORDER BY 1;"`,
      );
      console.log('=== DB tables ===\n' + tables);

      const login = await httpJson('POST', '/api/v1/admin/auth/login', {
        body: {
          email: process.env.ADMIN_EMAIL,
          password: process.env.ADMIN_PASSWORD,
        },
      });
      if (login.status >= 400) throw new Error('login failed ' + JSON.stringify(login.json));
      const token = login.json.accessToken;

      const status = await httpJson('GET', '/api/v1/admin/check24/status', { token });
      console.log('=== CHECK24 status ===\n', JSON.stringify(status.json, null, 2));

      const listings = await httpJson('GET', '/api/v1/admin/listings', { token });
      const first = Array.isArray(listings.json)
        ? listings.json.find((l) => l.isBookable) || listings.json[0]
        : listings.json?.items?.find((l) => l.isBookable) ||
          listings.json?.data?.[0];
      const hostawayId = first?.hostawayId;
      console.log('=== sample listing ===', hostawayId, first?.name);

      if (hostawayId) {
        const preview = await httpJson(
          'GET',
          `/api/v1/admin/check24/preview/${hostawayId}`,
          { token },
        );
        console.log(
          '=== preview status ===',
          preview.status,
          preview.json?.propertyId || preview.json?.message || preview.json,
        );
      }

      console.log('\nOK — production CHECK24 ready (staging API).');
    } catch (e) {
      console.error('VERIFY FAILED:', e.message);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .on('error', (e) => {
    console.error(e.message);
    process.exit(1);
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
