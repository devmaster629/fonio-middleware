-- Guest payment automation: deposit/balance schedules, CHECK24 pay-on-import, deadline cancel
ALTER TABLE "Reservation" ADD COLUMN "bookedAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "guestPaymentRequestSentAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "guestPaymentReminderSentAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "paymentDeadlineAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "pendingPaymentChargeId" INTEGER;
ALTER TABLE "Reservation" ADD COLUMN "paymentPhase" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "autoCanceledAt" TIMESTAMP(3);

ALTER TABLE "PortalPaymentRule" ADD COLUMN "depositDuePercent" INTEGER;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "depositDueDaysAfterBooking" INTEGER;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "autoRequestOnImport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "paymentDeadlineDays" INTEGER;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "autoSendGuestPaymentLink" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "guestReminderDaysBeforeDeadline" INTEGER;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "autoCancelIfUnpaid" BOOLEAN NOT NULL DEFAULT false;

-- CHECK24: pay on import, 7-day deadline, guest reminder 2 days before cancel
UPDATE "PortalPaymentRule"
SET
  "autoRequestOnImport" = true,
  "autoSendGuestPaymentLink" = true,
  "paymentDeadlineDays" = 7,
  "guestReminderDaysBeforeDeadline" = 2,
  "autoCancelIfUnpaid" = true,
  "hostDuePercent" = 100,
  "portalAssumedPaidPercent" = 0,
  "hostDueByDaysBeforeArrival" = 28
WHERE "portalKey" = 'check24';

-- Direct: 30% deposit within 7 days of booking, 70% balance 28 days before arrival
UPDATE "PortalPaymentRule"
SET
  "depositDuePercent" = 30,
  "depositDueDaysAfterBooking" = 7,
  "hostDuePercent" = 70,
  "hostDueByDaysBeforeArrival" = 28,
  "autoSendGuestPaymentLink" = true,
  "portalAssumedPaidPercent" = 0
WHERE "portalKey" = 'direct';
