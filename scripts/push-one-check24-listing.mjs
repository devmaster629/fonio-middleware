import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

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

const login = await httpJson('POST', '/api/v1/admin/auth/login', {
  body: {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  },
});
if (login.status >= 400) {
  console.error('login failed', login.json);
  process.exit(1);
}
const token = login.json.accessToken;

console.log('Pushing content for listing', hostawayId);
const push = await httpJson(
  'POST',
  `/api/v1/admin/check24/sync/${hostawayId}/content`,
  { token },
);
console.log('content push', push.status, JSON.stringify(push.json, null, 2));

console.log('Triggering availability+rates sync for that listing only...');
const sync = await httpJson('POST', '/api/v1/admin/check24/sync', {
  token,
  body: {
    content: false,
    availability: true,
    rates: true,
    listingIds: [Number(hostawayId)],
  },
});
console.log('sync start', sync.status, sync.json);

// wait a bit then check mappings/status
await new Promise((r) => setTimeout(r, 15000));
const status = await httpJson('GET', '/api/v1/admin/check24/status', { token });
const mappings = await httpJson('GET', '/api/v1/admin/check24/mappings', {
  token,
});
console.log('status', JSON.stringify(status.json, null, 2));
console.log(
  'mappings',
  JSON.stringify(
    (mappings.json || []).filter(
      (m) => m.listing?.hostawayId === Number(hostawayId),
    ),
    null,
    2,
  ),
);
