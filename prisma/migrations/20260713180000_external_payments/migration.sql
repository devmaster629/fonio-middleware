-- CreateEnum
CREATE TYPE "ExternalPaymentSource" AS ENUM ('QONTO', 'PAYPAL', 'MANUAL');

-- CreateEnum
CREATE TYPE "ExternalPaymentStatus" AS ENUM ('RECEIVED', 'PENDING_REVIEW', 'AUTO_APPLIED', 'MANUALLY_APPLIED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentMatchDecision" AS ENUM ('UNAMBIGUOUS', 'AMBIGUOUS', 'NO_MATCH', 'BULK_PAYMENT', 'REFUND', 'PARTIAL_UNCLEAR');

-- CreateTable
CREATE TABLE "ExternalPayment" (
    "id" TEXT NOT NULL,
    "source" "ExternalPaymentSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payerName" TEXT,
    "payerEmail" TEXT,
    "reference" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "ExternalPaymentStatus" NOT NULL DEFAULT 'RECEIVED',
    "matchDecision" "PaymentMatchDecision",
    "matchScore" DOUBLE PRECISION,
    "matchReason" TEXT,
    "matchCandidates" JSONB,
    "matchedReservationId" TEXT,
    "hostawayChargeId" INTEGER,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalPayment_source_externalId_key" ON "ExternalPayment"("source", "externalId");

-- CreateIndex
CREATE INDEX "ExternalPayment_status_idx" ON "ExternalPayment"("status");

-- CreateIndex
CREATE INDEX "ExternalPayment_createdAt_idx" ON "ExternalPayment"("createdAt");

-- CreateIndex
CREATE INDEX "ExternalPayment_matchedReservationId_idx" ON "ExternalPayment"("matchedReservationId");

-- AddForeignKey
ALTER TABLE "ExternalPayment" ADD CONSTRAINT "ExternalPayment_matchedReservationId_fkey" FOREIGN KEY ("matchedReservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
