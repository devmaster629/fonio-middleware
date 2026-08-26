-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "isPaid" BOOLEAN;
ALTER TABLE "Reservation" ADD COLUMN "paymentRequestSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PortalPaymentRule" (
    "id" TEXT NOT NULL,
    "portalKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "channelMatchersJson" TEXT NOT NULL DEFAULT '[]',
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "portalAssumedPaidPercent" INTEGER NOT NULL DEFAULT 0,
    "treatAsPaidUntilDaysBeforeArrival" INTEGER,
    "hostDuePercent" INTEGER NOT NULL DEFAULT 100,
    "hostDueByDaysBeforeArrival" INTEGER,
    "overdueGraceDays" INTEGER,
    "autoRequestInbox" BOOLEAN NOT NULL DEFAULT false,
    "skipUnpaidReminder" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalPaymentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalPaymentRule_portalKey_key" ON "PortalPaymentRule"("portalKey");
