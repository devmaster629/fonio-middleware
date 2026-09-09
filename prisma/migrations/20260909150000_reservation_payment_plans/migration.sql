-- CreateEnum
CREATE TYPE "PaymentPlanFrequency" AS ENUM ('WEEKLY', 'SEMI_MONTHLY', 'MONTHLY', 'CUSTOM');

-- CreateTable
CREATE TABLE "ReservationPaymentPlan" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "installmentAmount" DOUBLE PRECISION NOT NULL,
    "frequency" "PaymentPlanFrequency" NOT NULL DEFAULT 'MONTHLY',
    "customIntervalDays" INTEGER,
    "nextDueAmount" DOUBLE PRECISION NOT NULL,
    "nextDueAt" DATE,
    "paidTowardPlan" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationPaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservationPaymentPlan_reservationId_key" ON "ReservationPaymentPlan"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationPaymentPlan_enabled_nextDueAt_idx" ON "ReservationPaymentPlan"("enabled", "nextDueAt");

-- AddForeignKey
ALTER TABLE "ReservationPaymentPlan" ADD CONSTRAINT "ReservationPaymentPlan_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
