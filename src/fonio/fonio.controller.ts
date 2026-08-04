import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { FonioApiKeyGuard } from '../common/guards/fonio-api-key.guard';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { FonioCallContextDto } from './dto/call-context.dto';
import { GuestRequestDto } from './dto/guest-request.dto';
import { GuestVerifyDto } from './dto/guest-verify.dto';
import { BookingOfferDto } from './dto/booking-offer.dto';
import { PaymentReceivedDto } from './dto/payment-received.dto';
import { SendCheckinInfoDto } from './dto/send-checkin-info.dto';
import { FonioActivityService } from './fonio-activity.service';
import { listProvidedVerifyFields } from './fonio-activity.util';
import { FonioAvailabilityService } from './fonio-availability.service';
import { FonioBookingOfferService } from './fonio-booking-offer.service';
import { FonioCallContextService } from './fonio-call-context.service';
import { FonioCheckinEmailService } from './fonio-checkin-email.service';
import { FonioPaymentService } from './fonio-payment.service';
import { FonioRequestsService } from './fonio-requests.service';
import { FonioVerificationService } from './fonio-verification.service';

@ApiTags('fonio')
@ApiSecurity('fonio-api-key')
@Controller('api/v1/fonio')
@UseGuards(FonioApiKeyGuard)
export class FonioController {
  constructor(
    private readonly callContextService: FonioCallContextService,
    private readonly availability: FonioAvailabilityService,
    private readonly verification: FonioVerificationService,
    private readonly requests: FonioRequestsService,
    private readonly payments: FonioPaymentService,
    private readonly checkinEmail: FonioCheckinEmailService,
    private readonly bookingOffer: FonioBookingOfferService,
    private readonly activity: FonioActivityService,
  ) {}

  @Get('setup')
  @ApiOperation({ summary: 'fonio.ai integration URLs (copy into fonio dashboard)' })
  async getSetup(@Req() req: Request) {
    const data = await this.callContextService.getSetupDetails();
    await this.activity.record({
      action: 'setup',
      method: req.method,
      path: req.path,
      statusCode: 200,
      middlewareAction: 'Returned fonio integration URLs and live verification settings',
      outcome: 'success',
      requestReceived: {},
      responseRecorded: {
        bookingOfferEnabled: data.verification?.bookingOfferEnabled,
        minMatchCount: data.verification?.minMatchCount,
      },
    });
    return data;
  }

  @Post('call-context')
  @ApiOperation({ summary: 'Inbound webhook – caller context for fonio prompt' })
  async callContext(@Body() dto: FonioCallContextDto, @Req() req: Request) {
    const context = await this.callContextService.buildContext(dto);
    await this.activity.record({
      action: 'call_context',
      callId: dto.callId,
      method: req.method,
      path: req.path,
      statusCode: 200,
      requestReceived: dto,
      middlewareAction: context.caller_recognized
        ? 'Matched caller phone to upcoming reservation — returned greeting hints and verification rules'
        : 'No matching reservation for caller — returned default greeting and verification rules',
      outcome: 'success',
      responseRecorded: {
        caller_recognized: context.caller_recognized,
        has_upcoming_booking: context.has_upcoming_booking,
        hint_requires_verification: context.hint_requires_verification,
        verification_min_match_count: context.verification_min_match_count,
        booking_offer_enabled: context.booking_offer_enabled,
      },
    });
    return context;
  }

  @Get('availability')
  @ApiOperation({
    summary:
      'Search availability without exposing guest PII (cache-first for fast phone responses)',
  })
  async searchAvailability(
    @Query() query: AvailabilityQueryDto,
    @Req() req: Request,
  ) {
    const started = Date.now();
    const data = await this.availability.search(query);
    const durationMs = Date.now() - started;
    await this.activity.record({
      action: 'availability_search',
      method: req.method,
      path: req.path,
      statusCode: 200,
      durationMs,
      requestReceived: query,
      middlewareAction: `Searched ${data.meta.dataSource} calendars — ${data.availableCount} listing(s) available`,
      outcome: 'success',
      outcomeDetail: `${data.availableCount} available in ${durationMs}ms`,
      responseRecorded: {
        availableCount: data.availableCount,
        dataSource: data.meta.dataSource,
        responseMs: data.meta.responseMs,
        listings: (data.results ?? []).slice(0, 8).map((l) => ({
          listingId: l.listingId,
          name: l.name,
          city: l.city,
          available: l.available,
        })),
      },
      extra: {
        city: query.city,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        guests: query.guests,
        availableCount: data.availableCount,
        dataSource: data.meta.dataSource,
      },
    });
    return data;
  }

  @Get('guest/verify/requirements')
  @ApiOperation({
    summary: 'What the caller must provide for verification (for fonio prompt)',
  })
  async getVerifyRequirements(@Req() req: Request) {
    const result = await this.verification.getRequirements();
    await this.activity.record({
      action: 'verify_requirements',
      method: req.method,
      path: req.path,
      statusCode: 200,
      requestReceived: {},
      middlewareAction: 'Returned live verification rules from admin settings',
      outcome: 'success',
      responseRecorded: {
        minMatchCount: result.minMatchCount,
        optionalFields: result.optionalFields,
        bookingOfferEnabled: result.bookingOfferEnabled,
        hintDe: result.hintDe,
      },
    });
    return result;
  }

  @Post('guest/verify')
  @ApiOperation({ summary: 'Verify guest before sharing booking details' })
  async verifyGuest(@Body() dto: GuestVerifyDto, @Req() req: Request) {
    const requestReceived = {
      ...dto,
      fieldsProvided: listProvidedVerifyFields(dto),
      callId: dto.callId,
    };
    try {
      const result = await this.verification.verify(dto);
      await this.activity.record({
        action: 'guest_verify',
        callId: dto.callId,
        method: req.method,
        path: req.path,
        statusCode: 200,
        requestReceived,
        middlewareAction: `Guest verified — matched ${result.matchedFields.length} field(s): ${result.matchedFields.join(', ')}`,
        outcome: 'success',
        outcomeDetail: `Reservation ${result.reservation.id}`,
        responseRecorded: {
          verified: true,
          reservationId: result.reservation.id,
          matchedFields: result.matchedFields,
          listingName: result.reservation.listingName,
          status: result.reservation.status,
          hint: result.hint,
        },
        extra: {
          verified: true,
          reservationId: result.reservation.id,
          matchedFields: result.matchedFields,
        },
      });
      return result;
    } catch (error) {
      const raw =
        error instanceof UnauthorizedException ? error.getResponse() : null;
      const body =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : { message: raw ?? 'Verification failed' };
      await this.activity.record({
        action: 'guest_verify',
        callId: dto.callId,
        method: req.method,
        path: req.path,
        statusCode: 401,
        requestReceived,
        middlewareAction: 'Verification failed — insufficient matching fields or booking not found',
        outcome: 'failed',
        outcomeDetail: String(body.message ?? 'Verification failed'),
        responseRecorded: body,
        extra: {
          verified: false,
          message: body.message,
          matchedFields: body.matchedFields ?? [],
          missingFields: body.missingFields ?? [],
          requiredMinMatches: body.requiredMinMatches ?? null,
          stillNeedCount: body.stillNeedCount ?? null,
          whatToAskDe: body.whatToAskDe ?? null,
          hint: body.whatToAskDe ?? body.hint ?? null,
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
        },
      });
      throw error;
    }
  }

  @Get('guest/reservation')
  @ApiOperation({ summary: 'Get safe reservation summary (verified only)' })
  async getReservation(
    @Query('reservationId') reservationId: string,
    @Query('verificationToken') verificationToken: string,
    @Query('callId') callId: string | undefined,
    @Req() req: Request,
  ) {
    const result = await this.verification.getSafeReservation(
      Number(reservationId),
      verificationToken,
    );
    await this.activity.record({
      action: 'guest_reservation',
      callId,
      method: req.method,
      path: req.path,
      statusCode: 200,
      requestReceived: { reservationId: Number(reservationId), callId },
      middlewareAction: 'Returned safe reservation summary after token check',
      outcome: 'success',
      responseRecorded: result,
      extra: {
        reservationId: Number(reservationId),
        listingName: result.listingName,
        status: result.status,
      },
    });
    return result;
  }

  @Post('guest/requests')
  @ApiOperation({ summary: 'Submit a verified guest request' })
  async submitRequest(
    @Body() dto: GuestRequestDto,
    @Req() req: Request & { body: Record<string, unknown> },
  ) {
    const callerPhone =
      (req.body as { callerNumber?: string }).callerNumber ??
      (req.headers['x-caller-phone'] as string | undefined);
    const callId = (req.body as { callId?: string }).callId;

    try {
      const result = await this.requests.handleRequest(dto, callerPhone);
      const actionParts: string[] = [`Processed ${dto.requestType} request`];
      if (result.autoApproved) actionParts.push('auto-approved');
      if (result.hostawayApplied) actionParts.push('applied in Hostaway');
      if (result.forwardedToTeam) actionParts.push('forwarded to team');
      if (result.forwardedToHostaway) actionParts.push('posted to Hostaway inbox');
      if (result.inboxPending) actionParts.push('inbox pending');

      await this.activity.record({
        action: 'guest_request',
        callId,
        method: req.method,
        path: req.path,
        statusCode: 200,
        requestReceived: {
          reservationId: dto.reservationId,
          requestType: dto.requestType,
          callId,
          hasVerificationToken: Boolean(dto.verificationToken),
        },
        middlewareAction: actionParts.join(' — '),
        outcome: result.status === 'REJECTED' ? 'failed' : 'success',
        outcomeDetail: result.message,
        responseRecorded: result,
        extra: {
          reservationId: dto.reservationId,
          requestType: dto.requestType,
          status: result.status,
          autoApproved: result.autoApproved,
          hostawayApplied: result.hostawayApplied,
          hostawayApplyError: result.hostawayApplyError,
          forwardedToTeam: result.forwardedToTeam,
          forwardedToHostaway: result.forwardedToHostaway,
          inboxPending: result.inboxPending,
          reason: result.reason,
        },
      });
      return result;
    } catch (error) {
      const raw =
        error && typeof error === 'object' && 'getResponse' in error
          ? (error as { getResponse: () => unknown }).getResponse()
          : null;
      const body =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : {
              message:
                error instanceof Error ? error.message : 'Guest request failed',
            };
      const statusCode =
        error && typeof error === 'object' && 'getStatus' in error
          ? (error as { getStatus: () => number }).getStatus()
          : 400;
      const hintDe =
        typeof body.hintDe === 'string'
          ? body.hintDe
          : statusCode === 401
            ? 'Bitte zuerst „Gast verifizieren“ und verificationToken mitschicken.'
            : null;

      await this.activity.record({
        action: 'guest_request',
        callId,
        method: req.method,
        path: req.path,
        statusCode,
        requestReceived: {
          reservationId: dto.reservationId,
          requestType: dto.requestType,
          callId,
          hasVerificationToken: Boolean(dto.verificationToken),
        },
        middlewareAction: 'Guest request rejected',
        outcome: 'failed',
        outcomeDetail: String(body.message ?? 'Guest request failed'),
        responseRecorded: { ...body, hintDe },
        extra: {
          reservationId: dto.reservationId,
          requestType: dto.requestType,
        },
      });
      throw error;
    }
  }

  @Post('guest/payments')
  @ApiOperation({
    summary:
      'Record a guest payment in Hostaway and post a note to the reservation inbox',
  })
  async recordPayment(@Body() dto: PaymentReceivedDto, @Req() req: Request) {
    const callId = dto.callId;
    try {
      const result = await this.payments.recordPayment(dto);
      const actionParts = ['Recorded guest payment'];
      if (result.paymentRecorded) actionParts.push('offline charge created in Hostaway');
      if (result.inboxPosted) actionParts.push('posted to Hostaway inbox');
      if (result.inboxPending) actionParts.push('inbox pending');

      await this.activity.record({
        action: 'guest_payment',
        callId,
        method: req.method,
        path: req.path,
        statusCode: 200,
        requestReceived: {
          reservationId: dto.reservationId,
          amount: dto.amount,
          callId,
          hasVerificationToken: Boolean(dto.verificationToken),
        },
        middlewareAction: actionParts.join(' — '),
        outcome:
          result.paymentRecorded || result.inboxPosted ? 'success' : 'failed',
        outcomeDetail: result.message,
        responseRecorded: result,
        extra: {
          reservationId: dto.reservationId,
          amount: dto.amount,
          paymentRecorded: result.paymentRecorded,
          chargeId: result.chargeId,
          inboxPosted: result.inboxPosted,
        },
      });
      return result;
    } catch (error) {
      const raw =
        error && typeof error === 'object' && 'getResponse' in error
          ? (error as { getResponse: () => unknown }).getResponse()
          : null;
      const body =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : {
              message:
                error instanceof Error ? error.message : 'Payment recording failed',
            };
      const statusCode =
        error && typeof error === 'object' && 'getStatus' in error
          ? (error as { getStatus: () => number }).getStatus()
          : 400;

      await this.activity.record({
        action: 'guest_payment',
        callId,
        method: req.method,
        path: req.path,
        statusCode,
        requestReceived: {
          reservationId: dto.reservationId,
          amount: dto.amount,
          callId,
          hasVerificationToken: Boolean(dto.verificationToken),
        },
        middlewareAction: 'Payment recording rejected',
        outcome: 'failed',
        outcomeDetail: String(body.message ?? 'Payment recording failed'),
        responseRecorded: body,
        extra: {
          reservationId: dto.reservationId,
          amount: dto.amount,
        },
      });
      throw error;
    }
  }

  @Post('guest/send-checkin-info')
  @ApiOperation({
    summary:
      'After verification: send Hostaway Anreiseinfo / check-in template to the guest by email',
  })
  async sendCheckinInfo(
    @Body() dto: SendCheckinInfoDto,
    @Req() req: Request,
  ) {
    const callId = dto.callId;
    try {
      const result = await this.checkinEmail.sendCheckinInfo(dto);
      await this.activity.record({
        action: 'guest_send_checkin_info',
        callId,
        method: req.method,
        path: req.path,
        statusCode: 200,
        requestReceived: {
          reservationId: dto.reservationId,
          callId,
          hasVerificationToken: Boolean(dto.verificationToken),
        },
        middlewareAction: result.emailSent
          ? `Emailed Hostaway template "${result.templateName}"`
          : result.templateFound
            ? 'Check-in template found but email was not sent'
            : 'No matching Hostaway check-in template',
        outcome: result.emailSent ? 'success' : 'failed',
        outcomeDetail: result.message,
        responseRecorded: result,
        extra: {
          reservationId: dto.reservationId,
          emailSent: result.emailSent,
          templateId: result.templateId ?? null,
          templateName: result.templateName ?? null,
        },
      });
      return result;
    } catch (error) {
      const raw =
        error && typeof error === 'object' && 'getResponse' in error
          ? (error as { getResponse: () => unknown }).getResponse()
          : null;
      const body =
        raw && typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : {
              message:
                error instanceof Error
                  ? error.message
                  : 'Send check-in info failed',
            };
      const statusCode =
        error && typeof error === 'object' && 'getStatus' in error
          ? (error as { getStatus: () => number }).getStatus()
          : 400;

      await this.activity.record({
        action: 'guest_send_checkin_info',
        callId,
        method: req.method,
        path: req.path,
        statusCode,
        requestReceived: {
          reservationId: dto.reservationId,
          callId,
          hasVerificationToken: Boolean(dto.verificationToken),
        },
        middlewareAction: 'Check-in email request rejected',
        outcome: 'failed',
        outcomeDetail: String(body.message ?? 'Send check-in info failed'),
        responseRecorded: body,
        extra: {
          reservationId: dto.reservationId,
        },
      });
      throw error;
    }
  }

  @Post('booking-offer')
  @ApiOperation({
    summary:
      'Create a Hostaway booking inquiry when dates are available (no price quoted on phone)',
  })
  async createBookingOffer(@Body() dto: BookingOfferDto, @Req() req: Request) {
    const started = Date.now();
    try {
      const result = await this.bookingOffer.createOffer(dto);
      const durationMs = Date.now() - started;
      await this.activity.record({
        action: 'booking_offer',
        method: req.method,
        path: req.path,
        statusCode: 200,
        durationMs,
        requestReceived: dto,
        middlewareAction: `Created Hostaway booking inquiry #${result.reservationId} for ${result.listingName}`,
        outcome: 'success',
        outcomeDetail: result.guestMessage,
        responseRecorded: {
          offerCreated: result.offerCreated,
          reservationId: result.reservationId,
          listingName: result.listingName,
          checkIn: result.checkIn,
          checkOut: result.checkOut,
          status: result.status,
        },
        extra: {
          listingId: result.listingId,
          guests: result.guests,
        },
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const raw =
        error && typeof error === 'object' && 'getResponse' in error
          ? (error as { getResponse: () => unknown }).getResponse()
          : null;
      const message =
        raw && typeof raw === 'object' && raw !== null && 'message' in raw
          ? String((raw as { message: unknown }).message)
          : error instanceof Error
            ? error.message
            : 'Booking offer failed';
      await this.activity.record({
        action: 'booking_offer',
        method: req.method,
        path: req.path,
        statusCode: 400,
        durationMs,
        requestReceived: dto,
        middlewareAction: 'Booking offer rejected — listing unavailable or validation failed',
        outcome: 'failed',
        outcomeDetail: message,
        responseRecorded: {
          offerCreated: false,
          message,
        },
      });
      throw error;
    }
  }
}
