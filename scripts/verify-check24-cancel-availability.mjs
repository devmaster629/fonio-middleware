/**
 * Independent VERIFY: what CHECK24 API actually has for cancelled stays.
 * Does NOT ask CHECK24 staff — pulls their Supply API (same source they use).
 *
 * Usage: node scripts/verify-check24-cancel-availability.mjs
 */
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

const remote = `
set -e
cd ${APP_DIR}
docker compose -f docker-compose.prod.yml exec -T api node <<'NODE'
function nightStatus(ranges, ymd) {
  for (const r of ranges || []) {
    const from = String(r.dateFrom || '').slice(0, 10);
    const to = String(r.dateTo || '').slice(0, 10);
    if (ymd >= from && ymd <= to) {
      return r.availability || r.status || 'unknown';
    }
  }
  return 'MISSING';
}

function eachNight(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00.000Z'); d < new Date(to + 'T00:00:00.000Z'); d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

(async () => {
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('./dist/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(require('./dist/prisma/prisma.service').PrismaService);
  const check24 = app.get(require('./dist/check24/check24.client').Check24Client);

  const cancels = await prisma.check24Booking.findMany({
    where: { status: { in: ['cancelled', 'canceled', 'declined', 'failed'] } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });

  console.log('CHECK24_API_BASE=' + (process.env.CHECK24_API_BASE_URL || ''));
  const ping = await check24.ping();
  console.log('PING=' + JSON.stringify(ping));

  let fail = 0;
  let pass = 0;

  for (const c of cancels) {
    const raw = c.rawPayload && typeof c.rawPayload === 'object' ? c.rawPayload : {};
    const dateFrom = String(raw.dateFrom || '').slice(0, 10);
    const dateTo = String(raw.dateTo || '').slice(0, 10);
    const propertyId = c.check24PropertyId;
    if (!dateFrom || !dateTo || !propertyId) {
      console.log('SKIP ' + c.check24BookingId + ' incomplete payload');
      continue;
    }

    let bookingRemote = null;
    try {
      bookingRemote = await check24.getBooking(c.check24BookingId);
    } catch (e) {
      bookingRemote = { error: e.message || String(e) };
    }

    let ranges = [];
    try {
      ranges = await check24.getAvailabilities(propertyId);
    } catch (e) {
      console.log('FAIL ' + c.check24BookingId + ' getAvailabilities: ' + (e.message || e));
      fail += 1;
      continue;
    }

    const nights = eachNight(dateFrom, dateTo);
    const nightResults = nights.map((n) => ({ night: n, check24: nightStatus(ranges, n) }));
    const allOpen = nightResults.every((n) => String(n.check24).toLowerCase() === 'open');

    // Local calendar cross-check
    const reservation = c.hostawayReservationId
      ? await prisma.reservation.findUnique({ where: { hostawayId: c.hostawayReservationId } })
      : null;
    let localClosed = null;
    if (reservation) {
      localClosed = await prisma.calendarDay.count({
        where: {
          listingId: reservation.listingId,
          date: { gte: new Date(dateFrom), lt: new Date(dateTo) },
          isAvailable: false,
        },
      });
    }

    const line = {
      bookingId: c.check24BookingId,
      propertyId,
      stay: dateFrom + '→' + dateTo,
      localBookingStatus: c.status,
      hostawayReservationId: c.hostawayReservationId,
      hostawayLocalStatus: reservation?.status ?? null,
      check24BookingStatus: bookingRemote?.status ?? bookingRemote?.error ?? null,
      nights: nightResults,
      localClosedNights: localClosed,
      verdict: allOpen && localClosed === 0 ? 'PASS' : 'FAIL',
    };
    console.log(JSON.stringify(line));
    if (line.verdict === 'PASS') pass += 1;
    else fail += 1;
  }

  console.log('SUMMARY pass=' + pass + ' fail=' + fail);
  await app.close();
  process.exit(fail > 0 ? 2 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
NODE
`;

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      const b64 = Buffer.from(remote).toString('base64');
      const res = await exec(conn, `echo ${b64} | base64 -d | bash`);
      console.log(res.out);
      process.exitCode = res.code === 0 ? 0 : 1;
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
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
