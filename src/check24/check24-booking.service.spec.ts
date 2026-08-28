import { Check24BookingService } from './check24-booking.service';
import { Check24Booking } from './check24.types';

describe('Check24BookingService cancellations', () => {
  const prisma = {
    check24Booking: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    reservation: {
      findUnique: jest.fn(),
    },
  };
  const config = { get: jest.fn() };
  const check24 = {
    describeError: (err: unknown) =>
      err instanceof Error ? err.message : String(err),
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

  const service = new Check24BookingService(
    prisma as never,
    config as never,
    check24 as never,
    hostaway as never,
    hostawaySync as never,
    guestPayments as never,
  );

  const canceledBooking: Check24Booking = {
    bookingId: 'c24-1',
    propertyId: 'ha-172749',
    status: 'canceled',
    dateFrom: '2026-09-01',
    dateTo: '2026-09-03',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.check24Booking.upsert.mockResolvedValue({});
    prisma.check24Booking.update.mockResolvedValue({});
    hostawaySync.syncSingleReservation.mockResolvedValue({});
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
    expect(result).toMatchObject({
      processed: true,
      action: 'cancelled_in_hostaway',
      hostawayReservationId: 62144308,
    });
  });

  it('skips Hostaway when the reservation is already cancelled', async () => {
    prisma.check24Booking.findUnique.mockResolvedValue({
      hostawayReservationId: 62144308,
    });
    prisma.reservation.findUnique.mockResolvedValue({ status: 'cancelled' });

    const result = await service.processBooking(canceledBooking);

    expect(hostaway.cancelReservation).not.toHaveBeenCalled();
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
});
