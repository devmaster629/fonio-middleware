-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "externalPaymentId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "hostawayChargeId" INTEGER,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAllocation_externalPaymentId_idx" ON "PaymentAllocation"("externalPaymentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_reservationId_idx" ON "PaymentAllocation"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_externalPaymentId_reservationId_key" ON "PaymentAllocation"("externalPaymentId", "reservationId");

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_externalPaymentId_fkey" FOREIGN KEY ("externalPaymentId") REFERENCES "ExternalPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
