-- Add booking source/channel for payment reconciliation UI
ALTER TABLE "Reservation" ADD COLUMN "channelName" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "channelId" INTEGER;
