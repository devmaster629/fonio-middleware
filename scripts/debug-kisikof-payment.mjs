const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const r = await p.reservation.findUnique({
    where: { hostawayId: 60970823 },
    select: {
      hostawayId: true,
      guestName: true,
      channelName: true,
      guestNote: true,
      hostNote: true,
      comment: true,
      externalBookingRef: true,
      totalPrice: true,
      isPaid: true,
      arrivalDate: true,
      departureDate: true,
      status: true,
    },
  });
  console.log('RES', JSON.stringify(r, null, 2));

  const pay = await p.externalPayment.findMany({
    where: { OR: [{ amount: 395.36 }, { amount: 395.36000000000001 }] },
    orderBy: { occurredAt: 'desc' },
    take: 5,
    select: {
      id: true,
      amount: true,
      payerName: true,
      reference: true,
      status: true,
      matchDecision: true,
      matchScore: true,
      matchReason: true,
      matchCandidates: true,
      occurredAt: true,
    },
  });
  console.log('PAY_COUNT', pay.length);
  for (const row of pay) {
    const cands = Array.isArray(row.matchCandidates) ? row.matchCandidates : [];
    console.log(
      JSON.stringify(
        {
          id: row.id,
          amount: row.amount,
          payerName: row.payerName,
          reference: row.reference,
          status: row.status,
          matchDecision: row.matchDecision,
          matchScore: row.matchScore,
          matchReason: row.matchReason,
          candidateCount: cands.length,
          top: cands.slice(0, 3).map((c) => ({
            id: c.hostawayId,
            guest: c.guestName,
            score: c.score,
            reasons: c.reasons,
            balanceDue: c.balanceDue,
          })),
        },
        null,
        2,
      ),
    );
  }

  const htg = await p.portalPaymentRule.findUnique({ where: { portalKey: 'hometogo' } });
  console.log(
    'HTG_RULE',
    JSON.stringify(
      htg
        ? {
            enabled: htg.enabled,
            channelMatchersJson: htg.channelMatchersJson,
            portalAssumedPaidPercent: htg.portalAssumedPaidPercent,
            hostDuePercent: htg.hostDuePercent,
            treatAsPaidUntilDaysAfterDeparture: htg.treatAsPaidUntilDaysAfterDeparture,
            hostDueByDaysAfterDeparture: htg.hostDueByDaysAfterDeparture,
          }
        : null,
      null,
      2,
    ),
  );

  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
