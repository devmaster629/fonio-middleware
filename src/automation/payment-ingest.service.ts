import { Injectable } from '@nestjs/common';
import { ExternalPaymentSource } from '@prisma/client';
import { NormalizedExternalPayment } from './automation.types';

@Injectable()
export class PaymentIngestService {
  normalizeQontoPayload(payload: Record<string, unknown>): NormalizedExternalPayment | null {
    const data = (payload.data ?? payload) as Record<string, unknown>;
    const transaction = (data.transaction ??
      payload.transaction ??
      data ??
      payload) as Record<string, unknown>;
    const externalId = String(
      transaction.transaction_id ?? transaction.id ?? '',
    );
    if (!externalId) return null;

    // Qonto amounts are always positive; side decides credit/debit.
    const amount = Math.abs(Number(transaction.amount ?? 0));
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const reference = [
      transaction.reference,
      transaction.label,
      transaction.note,
      transaction.operation_type,
    ]
      .filter(Boolean)
      .map(String)
      .join(' | ');

    return {
      source: ExternalPaymentSource.QONTO,
      externalId,
      amount,
      currency: String(transaction.currency ?? 'EUR').toUpperCase(),
      occurredAt: new Date(
        String(transaction.settled_at ?? transaction.emitted_at ?? Date.now()),
      ),
      payerName:
        this.pickString(transaction, [
          'clean_counterparty_name',
          'counterparty_name',
          'label',
          'debtor_name',
        ]) ?? undefined,
      payerEmail: this.pickString(transaction, ['counterparty_email']),
      reference: reference || undefined,
      rawPayload: payload,
    };
  }

  normalizePayPalPayload(payload: Record<string, unknown>): NormalizedExternalPayment | null {
    const resource = (payload.resource ?? payload) as Record<string, unknown>;
    const externalId = String(
      resource.id ?? payload.id ?? resource.transaction_id ?? '',
    );
    if (!externalId) return null;

    const amountBlock = (resource.amount ??
      resource.seller_receivable_breakdown ??
      {}) as Record<string, unknown>;
    const amount = Math.abs(Number(amountBlock.value ?? resource.amount ?? 0));

    const payer = (resource.payer ?? {}) as Record<string, unknown>;
    const payerInfo = (payer.payer_info ?? payer) as Record<string, unknown>;
    const name = [payerInfo.given_name, payerInfo.surname]
      .filter(Boolean)
      .join(' ');

    return {
      source: ExternalPaymentSource.PAYPAL,
      externalId,
      amount,
      currency: String(amountBlock.currency_code ?? 'EUR').toUpperCase(),
      occurredAt: new Date(
        String(resource.create_time ?? resource.update_time ?? Date.now()),
      ),
      payerName: name || this.pickString(resource, ['payer_name', 'note']),
      payerEmail: this.pickString(payerInfo, ['email']),
      reference: this.pickString(resource, ['invoice_id', 'custom_id', 'note']),
      rawPayload: payload,
    };
  }

  private pickString(
    source: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  }
}
