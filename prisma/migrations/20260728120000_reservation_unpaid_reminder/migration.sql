-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "unpaidReminderSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Reservation_unpaidReminderSentAt_arrivalDate_idx" ON "Reservation"("unpaidReminderSentAt", "arrivalDate");
