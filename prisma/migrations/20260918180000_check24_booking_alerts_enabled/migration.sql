-- AlterTable
ALTER TABLE "Check24SyncSettings" ADD COLUMN IF NOT EXISTS "bookingAlertsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Check24SyncSettings" ADD COLUMN IF NOT EXISTS "bookingAlertsRegisteredAt" TIMESTAMP(3);
