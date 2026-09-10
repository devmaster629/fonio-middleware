-- Store Hostaway guest profile photo URL for admin UI avatars
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "guestPictureUrl" TEXT;
