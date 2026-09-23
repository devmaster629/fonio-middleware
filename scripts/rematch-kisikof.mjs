#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();
import { Client } from 'ssh2';
import { readFileSync } from 'fs';

const pass = process.env.VPS_PASSWORD;
const PAYMENT_ID = 'bfd11e76-1dad-415e-8fdc-2193cac9f311';

const rematchScript = `
const { PrismaClient, ExternalPaymentStatus } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  // Prefer portal booking code for Kisikof search
  await p.reservation.update({
    where: { hostawayId: 60970823 },
    data: { externalBookingRef: '18LLT0FVVF' },
  });
  // HomeToGo: expect bank payout ≈ booking total (0% means guest owes nothing)
  await p.portalPaymentRule.update({
    where: { portalKey: 'hometogo' },
    data: { hostDuePercent: 100 },
  });
  console.log('UPDATED_RES_AND_RULE');
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
`;

const conn = new Client();

function exec(cmd, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error('timeout'));
      }, timeoutMs);
      stream.on('data', (d) => {
        out += d.toString();
      });
      stream.stderr.on('data', (d) => {
        out += d.toString();
      });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(out || `failed ${code}`));
      });
    });
  });
}

conn
  .on('ready', async () => {
    try {
      const sftp = await new Promise((res, rej) =>
        conn.sftp((e, s) => (e ? rej(e) : res(s))),
      );
      await new Promise((res, rej) => {
        const ws = sftp.createWriteStream('/tmp/kisikof-fix.cjs');
        ws.on('close', res);
        ws.on('error', rej);
        ws.end(rematchScript);
      });
      sftp.end();

      console.log(
        await exec(
          'docker cp /tmp/kisikof-fix.cjs vermietung-api:/app/kisikof-fix.cjs && docker exec -w /app vermietung-api node /app/kisikof-fix.cjs',
        ),
      );

      // Rematch via nest API path: run matcher inside container with a small script
      const rematchMatch = `
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { PaymentReconciliationService } = require('./dist/automation/payment-reconciliation.service');
const { PrismaClient } = require('@prisma/client');
(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error','warn','log'] });
  const recon = app.get(PaymentReconciliationService);
  const result = await recon.rematchPendingReview(50, { forceAutoApply: false });
  console.log('REMATCH', JSON.stringify(result));
  const p = new PrismaClient();
  const pay = await p.externalPayment.findUnique({
    where: { id: '${PAYMENT_ID}' },
    select: {
      matchDecision: true,
      matchScore: true,
      matchReason: true,
      matchCandidates: true,
      status: true,
      matchedReservationId: true,
    },
  });
  const r = await p.reservation.findUnique({
    where: { hostawayId: 60970823 },
    select: { externalBookingRef: true, guestNote: true, channelName: true },
  });
  console.log('PAY_AFTER', JSON.stringify({
    ...pay,
    top: (pay.matchCandidates || []).slice(0,3).map(c => ({id:c.hostawayId,guest:c.guestName,score:c.score,reasons:c.reasons})),
  }, null, 2));
  console.log('RES_AFTER', JSON.stringify(r));
  await p.$disconnect();
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
`;
      await new Promise((res, rej) => {
        conn.sftp((e, sftp2) => {
          if (e) return rej(e);
          const ws = sftp2.createWriteStream('/tmp/kisikof-rematch.cjs');
          ws.on('close', res);
          ws.on('error', rej);
          ws.end(rematchMatch);
        });
      });
      console.log(
        await exec(
          'docker cp /tmp/kisikof-rematch.cjs vermietung-api:/app/kisikof-rematch.cjs && docker exec -w /app vermietung-api node /app/kisikof-rematch.cjs',
          180000,
        ),
      );
      console.log('DONE');
    } catch (e) {
      console.error(e.message || e);
      process.exitCode = 1;
    } finally {
      conn.end();
    }
  })
  .connect({
    host: '85.214.41.33',
    username: 'root',
    password: pass,
    readyTimeout: 30000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
