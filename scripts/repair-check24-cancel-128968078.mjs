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

const script = `
set -e
cd ${APP_DIR}
docker compose -f docker-compose.prod.yml exec -T api node <<'NODE'
const { NestFactory } = require('@nestjs/core');
(async () => {
  const { AppModule } = require('./dist/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const prisma = app.get(require('./dist/prisma/prisma.service').PrismaService);
  const hostaway = app.get(require('./dist/hostaway/hostaway.client').HostawayClient);
  const sync = app.get(require('./dist/check24/check24-sync.service').Check24SyncService);

  const hostawayId = 66567893;
  let remoteStatus = null;
  try {
    const cancelled = await hostaway.cancelReservation(hostawayId);
    remoteStatus = cancelled?.status ?? null;
    console.log('hostaway_cancel_result_status=' + remoteStatus);
  } catch (e) {
    console.log('hostaway_cancel_error=' + (e && e.message ? e.message : e));
  }

  await prisma.reservation.updateMany({
    where: { hostawayId },
    data: { status: 'cancelled' },
  });

  const r = await prisma.reservation.findUnique({
    where: { hostawayId },
    include: { listing: true },
  });
  console.log('local_status=' + r.status);

  const result = await sync.refreshAndPushAvailability(
    r.listing.id,
    r.listing.hostawayId,
    {
      forceOpenFrom: '2026-11-09',
      forceOpenTo: '2026-11-12',
      excludeHostawayReservationIds: [hostawayId],
      skipFollowUp: true,
    },
  );
  console.log('push=' + JSON.stringify(result));

  const days = await prisma.calendarDay.findMany({
    where: {
      listingId: r.listingId,
      date: { gte: new Date('2026-11-09'), lt: new Date('2026-11-12') },
    },
    orderBy: { date: 'asc' },
  });
  for (const d of days) {
    console.log(d.date.toISOString().slice(0, 10) + ' available=' + d.isAvailable);
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
      const b64 = Buffer.from(script).toString('base64');
      const res = await exec(conn, `echo ${b64} | base64 -d | bash`);
      console.log(res.out);
      console.log('exit', res.code);
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
