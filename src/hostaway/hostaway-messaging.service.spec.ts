import { RequestType } from '@prisma/client';
import { HostawayMessagingService } from './hostaway-messaging.service';

describe('HostawayMessagingService', () => {
  const hostaway = {
    sendConversationMessage: jest.fn(),
  };
  const service = new HostawayMessagingService(hostaway as never);

  beforeEach(() => jest.clearAllMocks());

  it('describes guest and pet changes', () => {
    expect(service.describeAppliedChange(RequestType.ADD_GUEST)).toBe('+1 Gast');
    expect(service.describeAppliedChange(RequestType.ADD_GUEST, 2)).toBe(
      '+2 Gäste',
    );
    expect(service.describeAppliedChange(RequestType.ADD_PET)).toBe(
      '+1 Haustier',
    );
  });

  it('builds applied-change inbox body in German', async () => {
    hostaway.sendConversationMessage.mockResolvedValue(101);
    const occurredAt = new Date('2026-07-13T08:35:00');

    const messageId = await service.notifyAppliedChangeToInbox({
      conversationId: 55,
      requestType: RequestType.ADD_GUEST,
      occurredAt,
    });

    expect(messageId).toBe(101);
    expect(hostaway.sendConversationMessage).toHaveBeenCalledWith(
      55,
      expect.stringContaining(
        'Telefonische Buchungsänderung durch Gast – 13.07.2026, 08:35 Uhr: +1 Gast',
      ),
      'channel',
    );
  });

  it('builds payment-received inbox body in German', async () => {
    hostaway.sendConversationMessage.mockResolvedValue(202);
    const occurredAt = new Date('2026-07-13T14:20:00');

    const messageId = await service.notifyPaymentReceivedToInbox({
      conversationId: 77,
      amount: 150,
      currency: 'EUR',
      occurredAt,
    });

    expect(messageId).toBe(202);
    expect(hostaway.sendConversationMessage).toHaveBeenCalledWith(
      77,
      expect.stringContaining('Zahlung eingegangen am 13.07.2026 um 14:20 Uhr.'),
      'channel',
    );
  });

  it('builds CHECK24 welcome body without Anreise details', () => {
    const body = service.buildGuestWelcomeBody({
      guestName: 'Max Mustermann',
      bookingRef: '128967787',
      listingName: 'Test Listing',
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      guestPortalUrl: 'https://guest.example/pay',
      amount: 381,
      currency: 'EUR',
    });
    expect(body).toContain('vielen Dank für Ihre Buchung');
    expect(body).toContain('128967787');
    expect(body).toContain('https://guest.example/pay');
    expect(body).toContain('erst nach Zahlungseingang');
    expect(body).not.toMatch(/Ihr Zugangscode lautet/i);
  });

  it('sends welcome via email and whatsapp', async () => {
    hostaway.sendConversationMessage
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12);
    const emailId = await service.sendGuestWelcomeMessage({
      conversationId: 9,
      body: 'hello',
      communicationType: 'email',
    });
    const waId = await service.sendGuestWelcomeMessage({
      conversationId: 9,
      body: 'hello',
      communicationType: 'whatsapp',
    });
    expect(emailId).toBe(11);
    expect(waId).toBe(12);
    expect(hostaway.sendConversationMessage).toHaveBeenNthCalledWith(
      1,
      9,
      'hello',
      'email',
    );
    expect(hostaway.sendConversationMessage).toHaveBeenNthCalledWith(
      2,
      9,
      'hello',
      'whatsapp',
    );
  });
});
