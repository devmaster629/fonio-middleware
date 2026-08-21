import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { LogLevel } from '@prisma/client';
import { Request, Response } from 'express';
import { sanitizeFonioPayload } from '../../fonio/fonio-activity.util';
import { AuditLogService } from '../../logging/audit-log.service';

@Catch()
@Injectable()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

  constructor(@Optional() private readonly audit?: AuditLogService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const isProd = process.env.NODE_ENV === 'production';

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const obj = body as Record<string, unknown>;
        message = (obj.message as string | string[]) ?? message;
        details = obj;
      }
    } else if (!isProd && exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const clientSafeFields = [
      'verified',
      'hint',
      'hintDe',
      'whatToAskDe',
      'stillNeedCount',
      'matchedFields',
      'missingFields',
      'requiredMinMatches',
      'reservationId',
      'fonioHint',
      'ambiguousCount',
    ];

    let clientDetails: Record<string, unknown> | undefined;
    if (typeof details === 'object' && details !== null) {
      const obj = details as Record<string, unknown>;
      clientDetails = {};
      for (const key of clientSafeFields) {
        if (obj[key] !== undefined) clientDetails[key] = obj[key];
      }
      if (!Object.keys(clientDetails).length) clientDetails = undefined;
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(clientDetails ?? {}),
      ...(isProd || status < 500
        ? {}
        : { error: exception instanceof Error ? exception.name : 'Error' }),
      ...(typeof details === 'object' &&
      details !== null &&
      !isProd &&
      status < 500
        ? { details }
        : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
    });

    // Validation errors (HTTP 400) are thrown by ValidationPipe BEFORE the
    // controller runs, so fonio endpoints never log them via activity.record.
    // Record them here so bad payloads (e.g. empty/invalid email) are visible
    // in the fonio Activity tab instead of failing silently.
    if (
      this.audit &&
      status === HttpStatus.BAD_REQUEST &&
      request.url?.includes('/api/v1/fonio/')
    ) {
      void this.logFonioValidationError(request, status, message);
    }
  }

  private async logFonioValidationError(
    request: Request,
    status: number,
    message: string | string[],
  ) {
    try {
      await this.audit!.log({
        level: LogLevel.WARN,
        source: 'fonio',
        action: this.fonioActionFromPath(request.url),
        method: request.method,
        path: request.url,
        statusCode: status,
        metadata: {
          outcome: 'failed',
          middlewareAction:
            'Request rejected by validation before processing (HTTP 400)',
          validationErrors: Array.isArray(message)
            ? message
            : [String(message)],
          requestReceived: sanitizeFonioPayload(
            (request.body ?? {}) as Record<string, unknown>,
          ),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record fonio validation error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private fonioActionFromPath(url: string): string {
    if (url.includes('guest/verify')) return 'guest_verify';
    if (url.includes('guest/requests')) return 'guest_request';
    if (url.includes('guest/reservation')) return 'guest_reservation';
    if (url.includes('availability/weekends')) return 'availability_weekends';
    if (url.includes('availability')) return 'availability';
    if (url.includes('booking-offer')) return 'booking_offer';
    if (url.includes('call-context')) return 'call_context';
    return 'fonio_request';
  }
}
