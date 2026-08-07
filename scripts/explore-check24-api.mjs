/**
 * Dev helper: log into CHECK24 Supply API staging docs and list OpenAPI paths.
 * Requires CHECK24_USERNAME + CHECK24_PASSWORD (portal login, not API token).
 */
import https from 'https';
import { URL, URLSearchParams } from 'url';
import fs from 'fs';

function request(method, urlStr, { headers = {}, body = null, cookies = [] } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (cookies.length) opts.headers.Cookie = cookies.join('; ');
    if (body) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: d,
          setCookie: res.headers['set-cookie'] || [],
          location: res.headers.location,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseCookies(setCookie) {
  return setCookie.map((c) => c.split(';')[0]);
}

function mergeCookies(existing, setCookie) {
  const map = new Map();
  for (const c of existing) map.set(c.split('=')[0], c);
  for (const c of parseCookies(setCookie)) map.set(c.split('=')[0], c);
  return [...map.values()];
}

const base = process.env.CHECK24_DOCS_BASE_URL ||
  'https://supplyapistaging.ferienwohnung.check24-test.de';
const username = process.env.CHECK24_USERNAME;
const password = process.env.CHECK24_PASSWORD;
if (!username || !password) {
  console.error('Set CHECK24_USERNAME and CHECK24_PASSWORD');
  process.exit(1);
}

const loginPage = await request('GET', `${base}/login`);
let cookies = parseCookies(loginPage.setCookie);
const csrfMatch = loginPage.body.match(/name="_csrf_token"\s+value="([^"]+)"/);
const csrf = csrfMatch ? csrfMatch[1] : 'csrf-token';

let login = await request('POST', `${base}/login`, {
  body: new URLSearchParams({
    _username: username,
    _password: password,
    _csrf_token: csrf,
  }).toString(),
  cookies,
});
cookies = mergeCookies(cookies, login.setCookie);

for (let i = 0; i < 5 && login.status >= 300 && login.status < 400 && login.location; i++) {
  const next = login.location.startsWith('http')
    ? login.location
    : `${base}${login.location}`;
  login = await request('GET', next, { cookies });
  cookies = mergeCookies(cookies, login.setCookie);
}

fs.mkdirSync('tmp-check24', { recursive: true });
const openapi = await request('GET', `${base}/openapi.json`, { cookies });
fs.writeFileSync('tmp-check24/openapi.json', openapi.body);
console.log('Saved tmp-check24/openapi.json', openapi.status, openapi.body.length);
