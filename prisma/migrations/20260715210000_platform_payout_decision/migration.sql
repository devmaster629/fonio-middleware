-- Auto-skip channel payouts (Airbnb, optionally Booking.com)
ALTER TYPE "PaymentMatchDecision" ADD VALUE 'PLATFORM_PAYOUT';
