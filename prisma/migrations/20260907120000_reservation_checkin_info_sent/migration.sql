-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkinInfoSentAt" TIMESTAMP(3);
