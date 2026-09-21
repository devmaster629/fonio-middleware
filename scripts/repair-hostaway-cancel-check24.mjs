/**
 * Cancel sticky Hostaway reservations for CHECK24-cancelled bookings
 * using PUT /reservations/{id}/statuses/cancelled (not status field update).
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
(async () => {
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('./dist/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const prisma = app.get(require('./dist/prisma/prisma.service').PrismaService);
  const hostaway = app.get(require('./dist/hostaway/hostaway.client').HostawayClient);
  const sync = app.get(require('./dist/check24/check24-sync.service').Check24SyncService);

  const cancels = await prisma.check24Booking.findMany({
    where: {
      status: { in: ['cancelled', 'canceled', 'declined', 'failed'] },
      hostawayReservationId: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
  });

  for (const c of cancels) {
    const id = c.hostawayReservationId;
    const raw = c.rawPayload && typeof c.rawPayload === 'object' ? c.rawPayload : {};
    const dateFrom = String(raw.dateFrom || '').slice(0, 10);
    const dateTo = String(raw.dateTo || '').slice(0, 10);
    console.log('--- ' + c.check24BookingId + ' hostaway=' + id + ' ' + dateFrom + '→' + dateTo);

    let before = null;
    try {
      before = await hostaway.getReservation(id);
      console.log('before_status=' + before.status);
    } catch (e) {
      console.log('before_fetch_error=' + (e.message || e));
    }

    if ((before?.status || '').toLowerCase() === 'cancelled' || (before?.status || '').toLowerCase() === 'canceled') {
      console.log('already_cancelled_on_hostaway');
    } else {
      try {
        const cancelled = await hostaway.cancelReservation(id, { cancelledBy: 'guest' });
        console.log('after_cancel_status=' + cancelled.status);
      } catch (e) {
        console.log('cancel_error=' + (e.message || e));
      }
    }

    await prisma.reservation.updateMany({
      where: { hostawayId: id },
      data: { status: 'cancelled' },
    });

    const local = await prisma.reservation.findUnique({
      where: { hostawayId: id },
      include: { listing: true },
    });
    if (local?.listing && dateFrom && dateTo) {
      const result = await sync.refreshAndPushAvailability(
        local.listing.id,
        local.listing.hostawayId,
        {
          forceOpenFrom: dateFrom,
          forceOpenTo: dateTo,
          excludeHostawayReservationIds: [id],
          skipFollowUp: true,
        },
      );
      console.log('push=' + JSON.stringify(result));
    }

    try {
      const after = await hostaway.getReservation(id);
      console.log('verify_hostaway_status=' + after.status);
    } catch (e) {
      console.log('verify_error=' + (e.message || e));
    }
  }

  await app.close();
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
