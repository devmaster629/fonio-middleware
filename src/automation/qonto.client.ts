import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface QontoBankAccount {
  id: string;
  slug?: string;
  iban?: string;
  currency?: string;
}

export interface QontoTransaction {
  id: string;
  transaction_id?: string;
  amount: number;
  amount_cents?: number;
  side: 'credit' | 'debit' | string;
  operation_type?: string;
  currency?: string;
  label?: string | null;
  reference?: string | null;
  note?: string | null;
  settled_at?: string | null;
  emitted_at?: string | null;
  status?: string;
  is_external_transaction?: boolean;
  clean_counterparty_name?: string | null;
  income?: {
    counterparty_account_number?: string;
  };
}

@Injectable()
export class QontoClient {
  private readonly logger = new Logger(QontoClient.name);
  private readonly http: AxiosInstance;
  private readonly login: string;
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    this.login =
      this.config.get<string>('QONTO_LOGIN') ??
      this.config.get<string>('QONTO_CLIENT_ID') ??
      '';
    this.secret =
      this.config.get<string>('QONTO_SECRET_KEY') ??
      this.config.get<string>('QONTO_CLIENT_SECRET') ??
      '';
    this.http = axios.create({
      baseURL:
        this.config.get<string>('QONTO_API_BASE_URL') ??
        'https://thirdparty.qonto.com',
      timeout: 30000,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.login && this.secret);
  }

  private authHeader() {
    return { Authorization: `${this.login}:${this.secret}` };
  }

  async getBankAccounts(): Promise<QontoBankAccount[]> {
    const { data } = await this.http.get('/v2/organization', {
      headers: this.authHeader(),
    });
    const org = data.organization ?? data;
    return (org.bank_accounts ?? []) as QontoBankAccount[];
  }

  async listCreditTransactions(params: {
    bankAccountId: string;
    settledAtFrom?: string;
    perPage?: number;
    page?: number;
  }): Promise<QontoTransaction[]> {
    const { data } = await this.http.get('/v2/transactions', {
      headers: this.authHeader(),
      params: {
        bank_account_id: params.bankAccountId,
        side: 'credit',
        'status[]': 'completed',
        settled_at_from: params.settledAtFrom,
        per_page: params.perPage ?? 50,
        page: params.page ?? 1,
      },
    });
    return (data.transactions ?? []) as QontoTransaction[];
  }

  async listRecentCredits(lookbackHours = 72): Promise<QontoTransaction[]> {
    if (!this.isConfigured()) {
      this.logger.warn('Qonto credentials missing — skip poll');
      return [];
    }

    const from = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
    const accounts = await this.getBankAccounts();
    const all: QontoTransaction[] = [];

    for (const account of accounts) {
      if (!account.id) continue;
      try {
        const page = await this.listCreditTransactions({
          bankAccountId: account.id,
          settledAtFrom: from,
          perPage: 50,
        });
        all.push(...page);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Qonto transactions failed';
        this.logger.warn(
          `Failed listing credits for account ${account.id}: ${message}`,
        );
      }
    }

    return all;
  }
}
