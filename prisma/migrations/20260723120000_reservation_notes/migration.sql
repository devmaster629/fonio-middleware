-- Hostaway host/guest notes used for deposit & payment matching
ALTER TABLE "Reservation" ADD COLUMN "hostNote" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "guestNote" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "comment" TEXT;
