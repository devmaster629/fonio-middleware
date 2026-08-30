-- Post-checkout payout verification (HomeToGo) and provider payout matching support
ALTER TABLE "PortalPaymentRule" ADD COLUMN "treatAsPaidUntilDaysAfterDeparture" INTEGER;
ALTER TABLE "PortalPaymentRule" ADD COLUMN "hostDueByDaysAfterDeparture" INTEGER;

-- HomeToGo: 100% collected by portal, verify payout after checkout (7d grace, overdue at 14d)
UPDATE "PortalPaymentRule"
SET
  "skipUnpaidReminder" = false,
  "treatAsPaidUntilDaysAfterDeparture" = 7,
  "hostDueByDaysAfterDeparture" = 14
WHERE "portalKey" = 'hometogo';
