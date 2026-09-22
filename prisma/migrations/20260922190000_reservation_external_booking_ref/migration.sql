-- Portal / channel booking code (HomeToGo, CHECK24, Airbnb confirmation, …)
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "externalBookingRef" TEXT;

CREATE INDEX IF NOT EXISTS "Reservation_externalBookingRef_idx"
  ON "Reservation"("externalBookingRef");
