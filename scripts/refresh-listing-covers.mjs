/**
 * Refresh listing coverImageUrl in production DB from Hostaway (stable S3 URLs).
 */
import dotenv from 'dotenv';
import axios from 'axios';
import { Client } from 'ssh2';
dotenv.config();

function isPreferred(url) {
  return /hostaway-platform|amazonaws\.com|cloudfront\.net/i.test(url);
}
function isFragile(url) {
  return /muscache\.com|airbnb\.|media\.vrbo\.|homeaway\./i.test(url);
}
function pickCover(listing) {
  const candidates = [];
  const push = (v) => {
    const url = v?.trim?.() || (typeof v === 'string' ? v.trim() : '');
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  push(listing.thumbnailUrl);
  push(listing.pictureUrl);
  const images = [...(listing.listingImages || [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  for (const img of images) push(img.url);
  if (!candidates.length) return null;
  return (
    candidates.find(isPreferred) ||
    candidates.find((u) => !isFragile(u)) ||
    candidates[0]
  );
}

const base = process.env.HOSTAWAY_API_BASE_URL || 'https://api.hostaway.com/v1';
const body = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: process.env.HOSTAWAY_ACCOUNT_ID,
  client_secret: process.env.HOSTAWAY_API_SECRET,
  scope: 'general',
});
const { data: tok } = await axios.post(`${base}/accessTokens`, body.toString(), {
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});
await new Promise((r) => setTimeout(r, 1100));
const headers = { Authorization: `Bearer ${tok.access_token}` };

const all = [];
for (let offset = 0; ; offset += 100) {
  const { data } = await axios.get(`${base}/listings`, {
    headers,
    params: { limit: 100, offset, includeResources: 1 },
  });
  const batch = data.result || [];
  all.push(...batch);
  if (batch.length < 100) break;
}

const covers = all
  .map((l) => ({ id: l.id, url: pickCover(l) }))
  .filter((x) => x.url);

console.log(`Fetched ${all.length} listings, ${covers.length} with covers`);

const values = covers
  .map(
    (c) =>
      `(${Number(c.id)}, '${JSON.stringify({ coverImageUrl: c.url }).replace(/'/g, "''")}'::jsonb)`,
  )
  .join(',\n');

const sql = `
UPDATE "Listing" AS l
SET "rawMetadata" = v.meta
FROM (VALUES
${values}
) AS v(hostaway_id, meta)
WHERE l."hostawayId" = v.hostaway_id;
`;

const remoteSql = `/tmp/refresh-covers.sql`;
const conn = new Client();
await new Promise((resolve, reject) => {
  conn
    .on('ready', async () => {
      try {
        await new Promise((res, rej) => {
          conn.sftp((err, sftp) => {
            if (err) return rej(err);
            const stream = sftp.createWriteStream(remoteSql);
            stream.on('close', res);
            stream.on('error', rej);
            stream.end(sql);
          });
        });
        console.log('Uploaded SQL');
        await new Promise((res, rej) => {
          conn.exec(
            `docker cp ${remoteSql} vermietung-postgres:/tmp/refresh-covers.sql && docker exec -i vermietung-postgres psql -U vermietung -d vermietung -f /tmp/refresh-covers.sql && rm -f ${remoteSql}`,
            (err, stream) => {
              if (err) return rej(err);
              stream.on('data', (d) => process.stdout.write(d.toString()));
              stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
              stream.on('close', (code) =>
                code === 0 ? res() : rej(new Error(`psql exit ${code}`)),
              );
            },
          );
        });
        console.log('DONE');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        conn.end();
      }
    })
    .on('error', reject)
    .connect({
      host: '85.214.41.33',
      username: 'root',
      password: process.env.VPS_PASSWORD,
      readyTimeout: 30000,
    });
});
