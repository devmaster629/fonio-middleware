-- CreateTable
CREATE TABLE "Check24PropertyMapping" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "check24PropertyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "contentSyncedAt" TIMESTAMP(3),
    "availabilitySyncedAt" TIMESTAMP(3),
    "ratesSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Check24PropertyMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Check24Booking" (
    "id" TEXT NOT NULL,
    "check24BookingId" TEXT NOT NULL,
    "check24PropertyId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hostawayReservationId" INTEGER,
    "rawPayload" JSONB,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Check24Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Check24PropertyMapping_listingId_key" ON "Check24PropertyMapping"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "Check24PropertyMapping_check24PropertyId_key" ON "Check24PropertyMapping"("check24PropertyId");

-- CreateIndex
CREATE INDEX "Check24PropertyMapping_enabled_idx" ON "Check24PropertyMapping"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Check24Booking_check24BookingId_key" ON "Check24Booking"("check24BookingId");

-- CreateIndex
CREATE INDEX "Check24Booking_status_idx" ON "Check24Booking"("status");

-- CreateIndex
CREATE INDEX "Check24Booking_check24PropertyId_idx" ON "Check24Booking"("check24PropertyId");

-- AddForeignKey
ALTER TABLE "Check24PropertyMapping" ADD CONSTRAINT "Check24PropertyMapping_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
