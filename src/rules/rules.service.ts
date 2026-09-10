import { Injectable } from '@nestjs/common';
import {
  ApprovalMode,
  Prisma,
  RequestType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApprovalConditions,
  DEFAULT_STANDARD_CHECK_IN,
  DEFAULT_STANDARD_CHECK_OUT,
  getRequestedTime,
  parseTimeToMinutes,
  sanitizeConditions,
} from './approval-conditions';

export interface RuleEvaluationContext {
  listingId?: string;
  requestType: RequestType;
  currentGuests?: number;
  requestedGuests?: number;
  petsRequested?: boolean;
  listingCapacity?: number;
  listingAllowsPets?: boolean;
  requestDetails?: Record<string, unknown>;
}

export interface RuleEvaluationResult {
  mode: ApprovalMode;
  ruleId?: string;
  reason: string;
}

@Injectable()
export class RulesService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(context: RuleEvaluationContext): Promise<RuleEvaluationResult> {
    const rules = await this.prisma.approvalRule.findMany({
      where: {
        isActive: true,
        requestType: context.requestType,
        OR: [
          { listingId: context.listingId ?? undefined },
          { listingId: null },
        ],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });

    const specific = rules.find((r) => r.listingId === context.listingId);
    const rule = specific ?? rules.find((r) => !r.listingId);

    if (!rule) {
      return this.defaultForRequestType(context);
    }

    if (rule.mode === ApprovalMode.DENY) {
      return {
        mode: ApprovalMode.DENY,
        ruleId: rule.id,
        reason: 'Request type denied by rule',
      };
    }

    if (rule.mode === ApprovalMode.MANUAL) {
      return {
        mode: ApprovalMode.MANUAL,
        ruleId: rule.id,
        reason: 'Manual approval required by rule',
      };
    }

    const autoCheck = this.checkAutoConditions(
      context,
      rule.conditions as ApprovalConditions | null,
    );
    if (!autoCheck.allowed) {
      return {
        mode: ApprovalMode.MANUAL,
        ruleId: rule.id,
        reason: autoCheck.reason,
      };
    }

    return {
      mode: ApprovalMode.AUTO,
      ruleId: rule.id,
      reason: 'Auto-approved by rule',
    };
  }

  checkAutoConditions(
    context: RuleEvaluationContext,
    conditions: ApprovalConditions | null,
  ): { allowed: boolean; reason: string } {
    const c = conditions ?? {};

    if (context.requestType === RequestType.CANCELLATION) {
      return {
        allowed: false,
        reason: 'Cancellations always require manual review',
      };
    }

    if (context.requestType === RequestType.ADD_GUEST) {
      const cap = context.listingCapacity ?? 0;
      const requested = context.requestedGuests ?? context.currentGuests ?? 0;
      if (requested > cap) {
        return {
          allowed: false,
          reason: 'Requested guests exceed listing capacity',
        };
      }
      if (c.maxAdditionalGuests !== undefined) {
        const additional =
          requested - (context.currentGuests ?? requested);
        if (additional > c.maxAdditionalGuests) {
          return {
            allowed: false,
            reason: `More than ${c.maxAdditionalGuests} additional guest(s) require manual approval`,
          };
        }
      }
    }

    if (context.requestType === RequestType.ADD_PET) {
      if (!context.listingAllowsPets) {
        return { allowed: false, reason: 'Pets not allowed for this listing' };
      }
      if (c.requireManualForPets === true) {
        return {
          allowed: false,
          reason: 'Pets require manual approval for this property',
        };
      }
    }

    if (context.requestType === RequestType.EARLY_CHECKIN) {
      return this.checkEarlyCheckIn(c, context.requestDetails);
    }

    if (context.requestType === RequestType.LATE_CHECKOUT) {
      return this.checkLateCheckOut(c, context.requestDetails);
    }

    return { allowed: true, reason: 'Conditions met' };
  }

  private checkEarlyCheckIn(
    conditions: ApprovalConditions,
    details?: Record<string, unknown>,
  ): { allowed: boolean; reason: string } {
    const requestedRaw = getRequestedTime(details);
    if (!requestedRaw) {
      return {
        allowed: false,
        reason: 'Requested check-in time required for auto-approval',
      };
    }

    const requested = parseTimeToMinutes(requestedRaw);
    const standard = parseTimeToMinutes(
      conditions.standardCheckInTime ?? DEFAULT_STANDARD_CHECK_IN,
    );
    const earliest = parseTimeToMinutes(
      conditions.earliestAllowedCheckIn ?? '14:00',
    );

    if (requested === null || standard === null || earliest === null) {
      return { allowed: false, reason: 'Invalid check-in time format' };
    }

    if (requested >= standard) {
      return {
        allowed: false,
        reason: 'Not an early check-in (at or after standard time)',
      };
    }

    if (requested < earliest) {
      return {
        allowed: false,
        reason: 'Requested check-in is earlier than allowed automatic window',
      };
    }

    return { allowed: true, reason: 'Early check-in within allowed window' };
  }

  private checkLateCheckOut(
    conditions: ApprovalConditions,
    details?: Record<string, unknown>,
  ): { allowed: boolean; reason: string } {
    const requestedRaw = getRequestedTime(details);
    if (!requestedRaw) {
      return {
        allowed: false,
        reason: 'Requested check-out time required for auto-approval',
      };
    }

    const requested = parseTimeToMinutes(requestedRaw);
    const standard = parseTimeToMinutes(
      conditions.standardCheckOutTime ?? DEFAULT_STANDARD_CHECK_OUT,
    );
    const latest = parseTimeToMinutes(
      conditions.latestAllowedCheckOut ?? '13:00',
    );

    if (requested === null || standard === null || latest === null) {
      return { allowed: false, reason: 'Invalid check-out time format' };
    }

    if (requested <= standard) {
      return {
        allowed: false,
        reason: 'Not a late check-out (at or before standard time)',
      };
    }

    if (requested > latest) {
      return {
        allowed: false,
        reason: 'Requested check-out is later than allowed automatic window',
      };
    }

    return { allowed: true, reason: 'Late check-out within allowed window' };
  }

  private defaultForRequestType(
    context: RuleEvaluationContext,
  ): RuleEvaluationResult {
    if (context.requestType === RequestType.CANCELLATION) {
      return {
        mode: ApprovalMode.MANUAL,
        reason: 'Default: cancellations forwarded to team',
      };
    }
    if (
      context.requestType === RequestType.EARLY_CHECKIN ||
      context.requestType === RequestType.LATE_CHECKOUT
    ) {
      return {
        mode: ApprovalMode.MANUAL,
        reason: 'Default: check-in/out changes require manual review',
      };
    }
    return {
      mode: ApprovalMode.MANUAL,
      reason: 'Default: manual approval required',
    };
  }

  sanitizeRuleConditions(
    requestType: string,
    mode: ApprovalMode,
    conditions?: Record<string, unknown>,
  ): Prisma.InputJsonValue | undefined {
    if (mode !== ApprovalMode.AUTO) return undefined;
    if (requestType === RequestType.CANCELLATION || requestType === 'CANCELLATION') {
      return undefined;
    }
    if (!(Object.values(RequestType) as string[]).includes(requestType)) {
      return undefined;
    }
    const sanitized = sanitizeConditions(requestType as RequestType, conditions);
    return sanitized as Prisma.InputJsonValue | undefined;
  }

  async seedDefaults() {
    const count = await this.prisma.approvalRule.count();
    if (count > 0) return;

    const defaults: {
      requestType: RequestType;
      mode: ApprovalMode;
      conditions?: Record<string, unknown>;
    }[] = [
      { requestType: RequestType.CANCELLATION, mode: ApprovalMode.MANUAL },
      { requestType: RequestType.MODIFICATION, mode: ApprovalMode.MANUAL },
      { requestType: RequestType.EARLY_CHECKIN, mode: ApprovalMode.MANUAL },
      { requestType: RequestType.LATE_CHECKOUT, mode: ApprovalMode.MANUAL },
      { requestType: RequestType.RESERVATION_QUESTION, mode: ApprovalMode.MANUAL },
      { requestType: RequestType.OTHER, mode: ApprovalMode.MANUAL },
      {
        requestType: RequestType.ADD_GUEST,
        mode: ApprovalMode.AUTO,
        conditions: { maxByCapacity: true },
      },
      {
        requestType: RequestType.ADD_PET,
        mode: ApprovalMode.AUTO,
        conditions: { requireManualForPets: false },
      },
    ];

    for (const rule of defaults) {
      await this.prisma.approvalRule.create({
        data: {
          requestType: rule.requestType,
          mode: rule.mode,
          conditions: rule.conditions as Prisma.InputJsonValue | undefined,
          priority: 0,
        },
      });
    }
  }
}
