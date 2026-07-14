import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type PayPalTransmissionHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

@Injectable()
export class PayPalClient {
  private readonly logger = new Logger(PayPalClient.name);
  private tokenCache: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get('PAYPAL_CLIENT_ID') &&
        this.config.get('PAYPAL_CLIENT_SECRET'),
    );
  }

  private apiBase(): string {
    return this.config.get('PAYPAL_MODE') === 'sandbox'
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.value;
    }

    const clientId = this.config.get<string>('PAYPAL_CLIENT_ID') ?? '';
    const clientSecret = this.config.get<string>('PAYPAL_CLIENT_SECRET') ?? '';
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${this.apiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`PayPal OAuth failed (${res.status})`);
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.tokenCache = {
      value: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }

  async verifyWebhookSignature(
    headers: PayPalTransmissionHeaders,
    event: Record<string, unknown>,
  ): Promise<boolean> {
    const webhookId = this.config.get<string>('PAYPAL_WEBHOOK_ID');
    if (!webhookId) {
      this.logger.warn('PAYPAL_WEBHOOK_ID missing — skipping signature verification');
      return true;
    }

    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.apiBase()}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transmission_id: headers.transmissionId,
          transmission_time: headers.transmissionTime,
          cert_url: headers.certUrl,
          auth_algo: headers.authAlgo,
          transmission_sig: headers.transmissionSig,
          webhook_id: webhookId,
          webhook_event: event,
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(`PayPal signature verify HTTP ${res.status}`);
      return false;
    }
    const data = (await res.json()) as { verification_status?: string };
    return data.verification_status === 'SUCCESS';
  }
}
