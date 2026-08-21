import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { phoneHashVariants } from '../common/utils/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { FonioCallContextDto } from './dto/call-context.dto';
import { FonioVerificationService } from './fonio-verification.service';

@Injectable()
export class FonioCallContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly verification: FonioVerificationService,
  ) {}

  async buildContext(dto: FonioCallContextDto) {
    const requirements = await this.verification.getRequirements();
    const base = {
      verified: false,
      caller_phone: dto.callerNumber ?? null,
      call_id: dto.callId ?? null,
      language: 'de',
      caller_recognized: false,
      has_upcoming_booking: false,
      guest_name_hint: null as string | null,
      guest_first_name_hint: null as string | null,
      greeting_hint:
        'Guten Tag, Sie erreichen brainions Vermietung. Wie kann ich Ihnen helfen?',
      hint_requires_verification: true,
      verification_hint_de: requirements.hintDe,
      verification_guest_script_de: requirements.guestScriptDe,
      verification_instructions_de: requirements.verificationInstructionsDe,
      verification_optional_fields_de: requirements.optionalFieldsListDe,
      verification_min_match_count: requirements.minMatchCount,
      verification_additional_min_match_count: requirements.additionalMinMatchCount,
      verification_post_verify_hint_de: requirements.postVerifyHintDe,
      booking_offer_enabled: requirements.bookingOfferEnabled,
    };

    if (!dto.callerNumber) {
      return base;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const hashes = phoneHashVariants(dto.callerNumber);
    const reservation = await this.prisma.reservation.findFirst({
      where: {
        phoneHash: { in: hashes },
        departureDate: { gte: today },
        NOT: { status: { in: ['cancelled', 'declined', 'expired'] } },
      },
      include: { listing: true },
      orderBy: { arrivalDate: 'asc' },
    });

    if (!reservation) {
      return base;
    }

    const firstName = reservation.guestFirstNameHint;
    const greeting = firstName
      ? `Guten Tag ${firstName}, Sie erreichen brainions Vermietung. Ich sehe, dass Sie eine anstehende Buchung haben. Wie kann ich Ihnen helfen?`
      : 'Guten Tag, Sie erreichen brainions Vermietung. Ich sehe, dass Sie eine anstehende Buchung haben. Wie kann ich Ihnen helfen?';

    return {
      ...base,
      caller_recognized: true,
      has_upcoming_booking: true,
      guest_name_hint: reservation.guestNameMasked,
      guest_first_name_hint: firstName,
      greeting_hint: greeting,
    };
  }

  getSetupUrls() {
    const base =
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000';
    const production =
      this.config.get<string>('PRODUCTION_URL') ??
      'https://vermietung.brainions.digital';

    return {
      local: this.buildUrlSet(base),
      production: this.buildUrlSet(production),
      fonioApiKeyConfigured: Boolean(this.config.get('FONIO_API_KEY')),
      notes: [
        'Use x-api-key header with your fonio API key on all fonio endpoints.',
        'call-context is the inbound webhook when a call starts.',
        'Use availability for exact dates; use availability/weekends when the guest says “a weekend in October/any weekend”.',
        'guest/verify is required before sharing full booking details.',
        'GET guest/verify/requirements returns live minMatchCount and hintDe — do not hardcode counts in fonio tools.',
        'booking-offer can be disabled in Admin → Rules & verification.',
      ],
    };
  }

  async getSetupDetails() {
    const requirements = await this.verification.getRequirements();
    return {
      ...this.getSetupUrls(),
      verification: requirements,
    };
  }

  private buildUrlSet(baseUrl: string) {
    const base = baseUrl.replace(/\/$/, '');
    return {
      call_context_webhook: `${base}/api/v1/fonio/call-context`,
      availability: `${base}/api/v1/fonio/availability`,
      availability_weekends: `${base}/api/v1/fonio/availability/weekends`,
      guest_verify: `${base}/api/v1/fonio/guest/verify`,
      guest_verify_requirements: `${base}/api/v1/fonio/guest/verify/requirements`,
      guest_reservation: `${base}/api/v1/fonio/guest/reservation`,
      guest_requests: `${base}/api/v1/fonio/guest/requests`,
      guest_payments: `${base}/api/v1/fonio/guest/payments`,
      guest_send_checkin_info: `${base}/api/v1/fonio/guest/send-checkin-info`,
      booking_offer: `${base}/api/v1/fonio/booking-offer`,
      hostaway_webhook: `${base}/webhooks/hostaway`,
      swagger_docs: `${base}/docs`,
    };
  }
}
