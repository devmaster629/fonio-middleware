/**
 * Smoke-test CHECK24 Supply API auth: GET /ping
 * Uses CHECK24_API_TOKEN + CHECK24_API_BASE_URL from .env
 */
import 'dotenv/config';
import https from 'https';
import { URL } from 'url';

const token = process.env.CHECK24_API_TOKEN;
const base =
  process.env.CHECK24_API_BASE_URL ||
  'https://supplyapistaging.ferienwohnung.check24-test.de/api/v2';

if (!token) {
  console.error('CHECK24_API_TOKEN missing');
  process.exit(1);
}

const u = new URL(`${base.replace(/\/$/, '')}/ping`);
const req = https.request(
  {
    method: 'GET',
    hostname: u.hostname,
    path: u.pathname,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  },
  (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      console.log('status', res.statusCode, d);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);
req.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
req.end();
