import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentPlanFrequency } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  applyPaymentToPlan,
  reversePaymentOnPlan,
  roundMoney,
} from './payment-plan.util';

export type UpsertPaymentPlanInput = {
  enabled?: boolean;
  installmentAmount?: number;
  frequency?: PaymentPlanFrequency;
  customIntervalDays?: number | null;
  nextDueAmount?: number;
  nextDueAt?: string | Date | null;
  paidTowardPlan?: number;
  currency?: string;
  note?: string | null;
};

@Injectable()
export class PaymentPlanService {
  constructor(private readonly prisma: PrismaService) {}

  async getByHostawayId(hostawayId: number) {
    const reservation = await this.requireReservation(hostawayId);
    const plan = await this.prisma.reservationPaymentPlan.findUnique({
      where: { reservationId: reservation.id },
    });
    return {
      reservation: {
        id: reservation.id,
        hostawayId: reservation.hostawayId,
        guestName: reservation.guestName,
        totalPrice: reservation.totalPrice,
        arrivalDate: reservation.arrivalDate,
        departureDate: reservation.departureDate,
        status: reservation.status,
      },
      plan,
    };
  }

  async listEnabled(limit = 100) {
    const take = Math.min(Math.max(limit, 1), 500);
    const plans = await this.prisma.reservationPaymentPlan.findMany({
      where: { enabled: true },
      include: {
        reservation: {
          include: { listing: true, notifiedCharges: true },
        },
      },
      orderBy: [{ nextDueAt: 'asc' }, { updatedAt: 'desc' }],
      take,
    });
    return plans.map((plan) => {
      const total =
        plan.reservation.totalPrice != null &&
        Number.isFinite(plan.reservation.totalPrice)
          ? plan.reservation.totalPrice
          : null;
      const paid = plan.reservation.notifiedCharges.reduce(
        (sum, charge) =>
          sum + (Number(charge.amount) > 0 ? Number(charge.amount) : 0),
        0,
      );
      return {
        ...plan,
        reservation: {
          id: plan.reservation.id,
          hostawayId: plan.reservation.hostawayId,
          guestName: plan.reservation.guestName,
          listingName: plan.reservation.listing.name,
          totalPrice: total,
          paidAmount: Math.round(paid * 100) / 100,
          arrivalDate: plan.reservation.arrivalDate,
          departureDate: plan.reservation.departureDate,
          status: plan.reservation.status,
        },
      };
    });
  }

  async upsertByHostawayId(hostawayId: number, input: UpsertPaymentPlanInput) {
    const reservation = await this.requireReservation(hostawayId);
    const existing = await this.prisma.reservationPaymentPlan.findUnique({
      where: { reservationId: reservation.id },
    });

    const frequency = input.frequency ?? existing?.frequency;
    const installmentAmountRaw =
      input.installmentAmount ?? existing?.installmentAmount;
    if (installmentAmountRaw == null || frequency == null) {
      throw new BadRequestException(
        'installmentAmount and frequency are required to create a payment plan',
      );
    }

    this.validateInput({
      ...input,
      installmentAmount: installmentAmountRaw,
      frequency,
    });

    const installmentAmount = roundMoney(installmentAmountRaw);
    const nextDueAmount = roundMoney(
      input.nextDueAmount != null
        ? input.nextDueAmount
        : (existing?.nextDueAmount ?? installmentAmount),
    );
    const nextDueAt =
      input.nextDueAt !== undefined
        ? this.parseDate(input.nextDueAt)
        : (existing?.nextDueAt ?? null);
    const paidTowardPlan = roundMoney(
      input.paidTowardPlan != null
        ? input.paidTowardPlan
        : (existing?.paidTowardPlan ?? 0),
    );
    const customIntervalDays =
      frequency === PaymentPlanFrequency.CUSTOM
        ? input.customIntervalDays !== undefined
          ? input.customIntervalDays
          : existing?.customIntervalDays ?? null
        : null;

    if (
      frequency === PaymentPlanFrequency.CUSTOM &&
      (customIntervalDays == null || customIntervalDays < 1)
    ) {
      throw new BadRequestException(
        'customIntervalDays is required when frequency is CUSTOM',
      );
    }

    return this.prisma.reservationPaymentPlan.upsert({
      where: { reservationId: reservation.id },
      create: {
        reservationId: reservation.id,
        enabled: input.enabled ?? true,
        installmentAmount,
        frequency,
        customIntervalDays,
        nextDueAmount,
        nextDueAt,
        paidTowardPlan,
        currency: input.currency?.trim() || existing?.currency || 'EUR',
        note:
          input.note === undefined
            ? null
            : input.note?.trim() || null,
      },
      update: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        installmentAmount,
        frequency,
        customIntervalDays,
        nextDueAmount,
        ...(input.nextDueAt !== undefined ? { nextDueAt } : {}),
        ...(input.paidTowardPlan != null ? { paidTowardPlan } : {}),
        ...(input.currency !== undefined
          ? { currency: input.currency?.trim() || 'EUR' }
          : {}),
        ...(input.note !== undefined
          ? { note: input.note?.trim() || null }
          : {}),
      },
    });
  }

  async deleteByHostawayId(hostawayId: number) {
    const reservation = await this.requireReservation(hostawayId);
    const existing = await this.prisma.reservationPaymentPlan.findUnique({
      where: { reservationId: reservation.id },
    });
    if (!existing) {
      throw new NotFoundException('Payment plan not found');
    }
    await this.prisma.reservationPaymentPlan.delete({
      where: { reservationId: reservation.id },
    });
    return { deleted: true };
  }

  /**
   * After a bank payment is applied to Hostaway, advance the installment ledger.
   */
  async recordPaymentApplied(reservationId: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const plan = await this.prisma.reservationPaymentPlan.findUnique({
      where: { reservationId },
      include: {
        reservation: { include: { notifiedCharges: true } },
      },
    });
    if (!plan || !plan.enabled) return null;

    const total =
      plan.reservation.totalPrice != null &&
      Number.isFinite(plan.reservation.totalPrice)
        ? plan.reservation.totalPrice
        : null;
    const paid = plan.reservation.notifiedCharges.reduce(
      (sum, charge) => sum + (Number(charge.amount) > 0 ? Number(charge.amount) : 0),
      0,
    );
    const remainingBalance =
      total != null ? Math.max(0, roundMoney(total - paid)) : null;

    const next = applyPaymentToPlan(plan, amount, { remainingBalance });

    return this.prisma.reservationPaymentPlan.update({
      where: { id: plan.id },
      data: {
        paidTowardPlan: next.paidTowardPlan,
        nextDueAmount: next.nextDueAmount,
        nextDueAt: next.nextDueAt,
      },
    });
  }

  /** Best-effort reverse when an applied payment is undone. */
  async recordPaymentReversed(reservationId: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const plan = await this.prisma.reservationPaymentPlan.findUnique({
      where: { reservationId },
      include: {
        reservation: { include: { notifiedCharges: true } },
      },
    });
    if (!plan) return null;

    const total =
      plan.reservation.totalPrice != null &&
      Number.isFinite(plan.reservation.totalPrice)
        ? plan.reservation.totalPrice
        : null;
    const paid = plan.reservation.notifiedCharges.reduce(
      (sum, charge) => sum + (Number(charge.amount) > 0 ? Number(charge.amount) : 0),
      0,
    );
    const remainingBalance =
      total != null ? Math.max(0, roundMoney(total - paid)) : null;

    const next = reversePaymentOnPlan(plan, amount, { remainingBalance });

    return this.prisma.reservationPaymentPlan.update({
      where: { id: plan.id },
      data: {
        paidTowardPlan: next.paidTowardPlan,
        nextDueAmount: next.nextDueAmount,
        nextDueAt: next.nextDueAt,
      },
    });
  }

  private async requireReservation(hostawayId: number) {
    if (!Number.isFinite(hostawayId) || hostawayId <= 0) {
      throw new BadRequestException('Invalid reservation id');
    }
    const reservation = await this.prisma.reservation.findUnique({
      where: { hostawayId },
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation #${hostawayId} not found`);
    }
    return reservation;
  }

  private validateInput(input: {
    installmentAmount: number;
    frequency: PaymentPlanFrequency;
    nextDueAmount?: number | null;
    paidTowardPlan?: number | null;
  }) {
    if (!Number.isFinite(input.installmentAmount) || input.installmentAmount < 0.01) {
      throw new BadRequestException('installmentAmount must be at least 0.01');
    }
    if (
      input.nextDueAmount != null &&
      (!Number.isFinite(input.nextDueAmount) || input.nextDueAmount < 0)
    ) {
      throw new BadRequestException('nextDueAmount must be >= 0');
    }
    if (
      input.paidTowardPlan != null &&
      (!Number.isFinite(input.paidTowardPlan) || input.paidTowardPlan < 0)
    ) {
      throw new BadRequestException('paidTowardPlan must be >= 0');
    }
    if (!Object.values(PaymentPlanFrequency).includes(input.frequency)) {
      throw new BadRequestException('Invalid frequency');
    }
  }

  private parseDate(value: string | Date | null | undefined): Date | null {
    if (value == null || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid nextDueAt date');
    }
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }
}
