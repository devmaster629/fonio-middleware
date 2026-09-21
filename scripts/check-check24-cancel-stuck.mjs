import { Client } from 'ssh2';
import dotenv from 'dotenv';

dotenv.config();

const VPS_HOST = process.env.VPS_HOST || process.env.VPS_IP_ADDRESS || '85.214.41.33';
const VPS_USER = process.env.VPS_USER || process.env.VPS_USERNAME || 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = process.env.DEPLOY_APP_DIR || '/root/fonio-middleware';

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

function psql(conn, sql) {
  const b64 = Buffer.from(sql).toString('base64');
  return exec(
    conn,
    `cd ${APP_DIR} && echo ${b64} | base64 -d | docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung`,
  );
}

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      const stuck = await psql(
        conn,
        `
SELECT c."check24BookingId", c.status AS c24_status, c."hostawayReservationId",
       r.status AS ha_status,
       c."rawPayload"->>'dateFrom' AS date_from,
       c."rawPayload"->>'dateTo' AS date_to,
       (
         SELECT COUNT(*) FROM "CalendarDay" cd
         WHERE cd."listingId" = r."listingId"
           AND cd.date >= (c."rawPayload"->>'dateFrom')::date
           AND cd.date < (c."rawPayload"->>'dateTo')::date
           AND cd."isAvailable" = false
       ) AS closed_nights
FROM "Check24Booking" c
LEFT JOIN "Reservation" r ON r."hostawayId" = c."hostawayReservationId"
WHERE lower(c.status) IN ('cancelled','canceled','declined','failed')
ORDER BY c."updatedAt" DESC
LIMIT 20;
`,
      );
      console.log('=== CANCELLED BOOKINGS / CLOSED NIGHTS ===\n' + stuck.out);

      const webhook = await psql(
        conn,
        `SELECT "bookingAlertsEnabled", "bookingAlertsRegisteredAt", "lastAutoSyncAt" FROM "Check24SyncSettings" WHERE id = 'default';`,
      );
      console.log('=== SYNC SETTINGS ===\n' + webhook.out);
    } catch (err) {
      console.error(err);
    } finally {
      conn.end();
    }
  })
  .connect({
    host: VPS_HOST,
    username: VPS_USER,
    password: VPS_PASS,
    algorithms: { serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'] },
  });
