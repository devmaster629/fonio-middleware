#!/usr/bin/env node
/**
 * Local-only SMTP verification for payment alerts.
 * Reads PAYMENT_ALERT_* from .env and sends one test message.
 * Does NOT touch the VPS / production server.
 *
 * Usage:
 *   node scripts/verify-payment-alert-smtp-local.mjs
 *   PAYMENT_ALERT_TO=you@example.com node scripts/verify-payment-alert-smtp-local.mjs
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';

const host = process.env.PAYMENT_ALERT_SMTP_HOST;
const port = Number(process.env.PAYMENT_ALERT_SMTP_PORT || 587);
const secure = process.env.PAYMENT_ALERT_SMTP_SECURE === 'true';
const user = process.env.PAYMENT_ALERT_SMTP_USER;
const pass = process.env.PAYMENT_ALERT_SMTP_PASS;
const from = process.env.PAYMENT_ALERT_FROM;
const to = process.env.PAYMENT_ALERT_TO;
const correlationId = `local-smtp-test-${Date.now()}`;

if (!host || !from || !to || !user || !pass) {
  console.error('Missing PAYMENT_ALERT_* env values. Check local .env');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
});

const info = await transporter.sendMail({
  from,
  to,
  subject: `[Hostaway Payments] Local SMTP test ${correlationId}`,
  text: [
    'Local SMTP verification (not production deploy).',
    `Correlation ID: ${correlationId}`,
    `SMTP host: ${host}:${port}`,
    `From: ${from}`,
    `To: ${to}`,
    '',
    'If you receive this, inbox delivery works for this mailbox.',
  ].join('\n'),
  headers: { 'X-Correlation-Id': correlationId },
});

console.log(
  JSON.stringify(
    {
      ok: true,
      correlationId,
      messageId: info.messageId ?? null,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
      response: info.response ?? null,
      to,
      from,
      host,
      port,
    },
    null,
    2,
  ),
);
