/**
 * One-shot rematch of PENDING_REVIEW payments (run inside the API container from /app).
 */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const {
  PaymentReconciliationService,
} = require('./dist/automation/payment-reconciliation.service');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const svc = app.get(PaymentReconciliationService);
    const result = await svc.rematchPendingReview(100);
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
