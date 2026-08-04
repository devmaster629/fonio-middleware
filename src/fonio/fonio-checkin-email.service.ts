import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HostawayConversationService } from '../hostaway/hostaway-conversation.service';
import { HostawayMessagingService } from '../hostaway/hostaway-messaging.service';
import { PrismaService } from '../prisma/prisma.service';
import { SendCheckinInfoDto } from './dto/send-checkin-info.dto';
import { FonioVerificationService } from './fonio-verification.service';

@Injectable()
export class FonioCheckinEmailService {
  private readonly logger = new Logger(FonioCheckinEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: FonioVerificationService,
    private readonly conversations: HostawayConversationService,
    private readonly messaging: HostawayMessagingService,
  ) {}

  async sendCheckinInfo(dto: SendCheckinInfoDto) {
    await this.verification.assertVerified(
      dto.verificationToken,
      dto.reservationId,
    );

    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId: dto.reservationId },
      include: { listing: true },
    });

    if (!reservation) {
      throw new NotFoundException('Reservation not found');
    }

    const template = await this.messaging.resolveCheckinTemplate({
      reservationHostawayId: reservation.hostawayId,
      listingHostawayId: reservation.listing.hostawayId,
    });

    if (!template) {
      this.logger.warn(
        `No Hostaway check-in template found for reservation ${reservation.hostawayId}`,
      );
      return {
        emailSent: false,
        templateFound: false,
        guestMessageDe:
          'Ich kann die Anreiseinformationen gerade nicht automatisch per E-Mail senden. Unser Team schickt Ihnen Adresse und Zugang zeitnah zu.',
        message:
          'No matching Hostaway check-in / Anreiseinfo template found for this reservation',
        hintDe:
          'Kein Anreise-Template gefunden. Dem Gast sagen, dass das Team die Infos per E-Mail nachreicht — NICHT behaupten, die Mail sei bereits versendet.',
      };
    }

    const conversationId = await this.conversations.resolveConversationId(
      reservation.hostawayId,
    );

    if (!conversationId) {
      this.logger.warn(
        `No Hostaway conversation for reservation ${reservation.hostawayId} — cannot email check-in template`,
      );
      return {
        emailSent: false,
        templateFound: true,
        templateId: template.id,
        templateName: template.name,
        guestMessageDe:
          'Ich kann die Anreiseinformationen gerade nicht automatisch per E-Mail senden. Unser Team schickt Ihnen Adresse und Zugang zeitnah zu.',
        message: 'No Hostaway guest conversation found for this reservation',
        hintDe:
          'Keine Hostaway-Konversation gefunden. Dem Gast sagen, dass das Team die Infos per E-Mail nachreicht — NICHT behaupten, die Mail sei bereits versendet.',
      };
    }

    try {
      const messageId = await this.messaging.sendCheckinInfoEmail({
        conversationId,
        template,
      });

      return {
        emailSent: true,
        templateFound: true,
        templateId: template.id,
        templateName: template.name,
        conversationId,
        hostawayMessageId: messageId,
        guestMessageDe:
          'Ich habe Ihnen soeben die Anreiseinformationen mit Adresse und Zugang per E-Mail geschickt. Bitte prüfen Sie auch Ihren Spam-Ordner.',
        message: `Sent Hostaway template "${template.name}" by email`,
      };
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : 'Hostaway email send failed';
      this.logger.error(
        `Failed to email check-in template for reservation ${reservation.hostawayId}: ${errMsg}`,
      );
      return {
        emailSent: false,
        templateFound: true,
        templateId: template.id,
        templateName: template.name,
        conversationId,
        hostawayError: errMsg,
        guestMessageDe:
          'Ich konnte die Anreiseinformationen gerade nicht automatisch per E-Mail senden. Unser Team schickt Ihnen Adresse und Zugang zeitnah zu.',
        message: errMsg,
        hintDe:
          'E-Mail-Versand fehlgeschlagen. Dem Gast sagen, dass das Team die Infos nachreicht — NICHT behaupten, die Mail sei bereits versendet.',
      };
    }
  }
}
