import { ServiceUnavailableException } from '@nestjs/common';
import { FonioBookingOfferService } from './fonio-booking-offer.service';

describe('FonioBookingOfferService', () => {
  const listing = {
    hostawayId: 111,
    name: 'Test Listing',
    city: 'Stuttgart',
    isBookable: true,
  };

  function buildService(overrides: {
    createReservation?: jest.Mock;
    getReservation?: jest.Mock;
    updateReservation?: jest.Mock;
    cancelReservation?: jest.Mock;
    requestDeposit?: jest.Mock;
    syncSingle?: jest.Mock;
  }) {
    const prisma = {
      listing: { findUnique: jest.fn().mockResolvedValue(listing) },
      reservation: {
        findUnique: jest.fn().mockResolvedValue({ id: 'local-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      verificationConfig: {
        findFirst: jest.fn().mockResolvedValue({ bookingOfferEnabled: true }),
      },
    };
    const hostaway = {
      calculatePriceDetails: jest.fn().mockResolvedValue({
        totalPrice: 4000,
        components: [],
      }),
      createReservation:
        overrides.createReservation ??
        jest.fn().mockResolvedValue({ id: 999, status: 'inquiry' }),
      getReservation:
        overrides.getReservation ??
        jest.fn().mockResolvedValue({ id: 999, status: 'inquiry' }),
      updateReservation: overrides.updateReservation ?? jest.fn(),
      cancelReservation: overrides.cancelReservation ?? jest.fn(),
    };
    const availability = {
      search: jest.fn().mockResolvedValue({
        availableCount: 1,
        results: [{ listingId: 111, available: true }],
      }),
    };
    const sync = {
      syncSingleReservation:
        overrides.syncSingle ?? jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const guestPayments = {
      requestDepositAfterFonioOffer:
        overrides.requestDeposit ??
        jest.fn().mockResolvedValue({ ok: true, chargeId: 1 }),
    };

    const service = new FonioBookingOfferService(
      prisma as never,
      hostaway as never,
      availability as never,
      sync as never,
      config as never,
      guestPayments as never,
    );
    return { service, hostaway, guestPayments, sync };
  }

  const dto = {
    listingId: 111,
    checkIn: '2026-10-10',
    checkOut: '2026-10-17',
    guests: 2,
    guestFirstName: 'Max',
    guestLastName: 'Mustermann',
    guestEmail: 'max.mustermann@gmail.com',
    phone: '+491701234567',
  };

  it('creates inquiry + deposit and does not expose totalPrice', async () => {
    const { service } = buildService({});
    const result = await service.createOffer(dto as never);
    expect(result.offerCreated).toBe(true);
    expect(result.depositRequested).toBe(true);
    expect(result.status).toBe('inquiry');
    expect(result).not.toHaveProperty('totalPrice');
  });

  it('cancels when Hostaway creates a confirmed booking that cannot be forced to inquiry', async () => {
    const cancelReservation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { service, hostaway } = buildService({
      createReservation: jest.fn().mockResolvedValue({ id: 999, status: 'new' }),
      getReservation: jest
        .fn()
        .mockResolvedValueOnce({ id: 999, status: 'new' })
        .mockResolvedValueOnce({ id: 999, status: 'new' }),
      updateReservation: jest.fn().mockResolvedValue({ id: 999, status: 'new' }),
      cancelReservation,
    });

    await expect(service.createOffer(dto as never)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(cancelReservation).toHaveBeenCalledWith(999);
    expect(hostaway.updateReservation).toHaveBeenCalledWith(999, {
      status: 'inquiry',
    });
  });

  it('cancels when deposit request fails', async () => {
    const cancelReservation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { service } = buildService({
      requestDeposit: jest.fn().mockResolvedValue({
        ok: false,
        reason: 'no_portal_rule',
      }),
      cancelReservation,
    });

    await expect(service.createOffer(dto as never)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(cancelReservation).toHaveBeenCalledWith(999);
  });

  it('rejects placeholder contact before creating a reservation', async () => {
    const createReservation = jest.fn();
    const { service } = buildService({ createReservation });
    await expect(
      service.createOffer({
        ...dto,
        guestEmail: 'test@example.com',
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ offerCreated: false }),
    });
    expect(createReservation).not.toHaveBeenCalled();
  });
});
