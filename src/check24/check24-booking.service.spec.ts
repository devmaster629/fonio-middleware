import { Check24BookingService } from './check24-booking.service';
import { Check24Booking } from './check24.types';

describe('Check24BookingService cancellations', () => {
  const prisma = {
    check24Booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    reservation: {
      findUnique: jest.fn(),
    },
    check24PropertyMapping: {
      findUnique: jest.fn(),
    },
  };
  const config = { get: jest.fn() };
  const check24 = {
    describeError: (err: unknown) =>
      err instanceof Error ? err.message : String(err),
    cancelBooking: jest.fn(),
    isConfigured: jest.fn().mockReturnValue(true),
  };
  const hostaway = {
    cancelReservation: jest.fn(),
    createReservation: jest.fn(),
    getCustomFields: jest.fn(),
    updateReservation: jest.fn(),
  };
  const hostawaySync = {
    syncSingleReservation: jest.fn(),
  };
  const guestPayments = {
    requestPaymentOnImport: jest.fn().mockResolvedValue({ ok: false }),
  };
  const check24Sync = {
    refreshAndPushAvailability: jest.fn().mockResolvedValue({ pushed: true }),
  };

  const service = new Check24BookingService(
    prisma as never,
    config as never,
    check24 as never,
    hostaway as never,
    hostawaySync as never,
    check24Sync as never,
    guestPayments as never,
  );

  const canceledBooking: Check24Booking = {
    bookingId: 'c24-1',
    propertyId: 'ha-172749',
    status: 'cancelled',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-03',
  };

  const mapping = {
    listing: { id: 'listing-1', hostawayId: 172749 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.check24Booking.upsert.mockResolvedValue({});
    prisma.check24Booking.update.mockResolvedValue({});
    hostawaySync.syncSingleReservation.mockResolvedValue({});
    prisma.check24PropertyMapping.findUnique.mockResolvedValue(mapping);
  });

  it('does not call Hostaway when a cancel has no imported reservation', async () => {
    prisma.check24Booking.findUnique.mockResolvedValue(null);

    const result = await service.processBooking(canceledBooking);

    expect(result).toMatchObject({
      processed: true,
      action: 'ignored_terminal_status',
      hostawayReservationId: null,
    });
    expect(hostaway.cancelReservation).not.toHaveBeenCalled();
    expect(check24Sync.refreshAndPushAvailability).toHaveBeenCalledWith(
      'listing-1',
      172749,
    );
  });

  it('cancels the Hostaway reservation after a CHECK24 cancellation', async () => {
    prisma.check24Booking.findUnique.mockResolvedValue({
      hostawayReservationId: 62144308,
    });
    prisma.reservation.findUnique.mockResolvedValue({ status: 'new' });
    hostaway.cancelReservation.mockResolvedValue({ status: 'cancelled' });

    const result = await service.processBooking(canceledBooking);

    expect(hostaway.cancelReservation).toHaveBeenCalledWith(62144308);
    expect(hostawaySync.syncSingleReservation).toHaveBeenCalledWith(62144308);
    expect(check24Sync.refreshAndPushAvailability).toHaveBeenCalledWith(
      'listing-1',
      172749,
    );
    expect(result).toMatchObject({
      processed: true,
      action: 'cancelled_in_hostaway',
      hostawayReservationId: 62144308,
    });
  });

  it('still pushes availability when Hostaway is already cancelled', async () => {
    prisma.check24Booking.findUnique.mockResolvedValue({
      hostawayReservationId: 62144308,
    });
    prisma.reservation.findUnique.mockResolvedValue({ status: 'cancelled' });

    const result = await service.processBooking(canceledBooking);

    expect(hostaway.cancelReservation).not.toHaveBeenCalled();
    expect(check24Sync.refreshAndPushAvailability).toHaveBeenCalledWith(
      'listing-1',
      172749,
    );
    expect(result).toMatchObject({
      processed: true,
      action: 'already_cancelled',
    });
  });

  it('does not throw when Hostaway cancel fails', async () => {
    prisma.check24Booking.findUnique.mockResolvedValue({
      hostawayReservationId: 62144308,
    });
    prisma.reservation.findUnique.mockResolvedValue({ status: 'modified' });
    hostaway.cancelReservation.mockRejectedValue(new Error('Hostaway 400'));

    const result = await service.processBooking(canceledBooking);

    expect(result).toMatchObject({
      processed: false,
      action: 'cancel_failed',
      hostawayReservationId: 62144308,
    });
    expect(prisma.check24Booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('Hostaway cancel failed'),
        }),
      }),
    );
  });

  it('propagates Hostaway cancel to CHECK24 cancel endpoint', async () => {
    prisma.check24Booking.findFirst.mockResolvedValue({
      check24BookingId: 'c24-1',
      check24PropertyId: 'ha-172749',
      status: 'booked',
    });
    check24.cancelBooking.mockResolvedValue({});

    const result = await service.propagateHostawayCancellation(62144308, {
      cancelReason: 'missingIncompletePayment',
      cancelMessage: 'unpaid',
    });

    expect(check24.cancelBooking).toHaveBeenCalledWith('c24-1', {
      cancelledBy: 'Provider',
      cancelReason: 'missingIncompletePayment',
      cancelMessage: 'unpaid',
      currencyCode: 'EUR',
      cancelFee: 0,
    });
    expect(check24Sync.refreshAndPushAvailability).toHaveBeenCalledWith(
      'listing-1',
      172749,
    );
    expect(result).toMatchObject({
      processed: true,
      action: 'cancelled_on_check24',
    });
  });
});
