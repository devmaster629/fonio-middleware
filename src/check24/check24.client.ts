import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  Check24Availability,
  Check24Booking,
  Check24Property,
  Check24Rate,
  Check24WebhookRegistration,
} from './check24.types';

@Injectable()
export class Check24Client {
  private readonly logger = new Logger(Check24Client.name);
  private readonly http: AxiosInstance;
  private readonly token: string;

  constructor(private readonly config: ConfigService) {
    this.token = (this.config.get<string>('CHECK24_API_TOKEN') ?? '').trim();
    const baseURL =
      this.config.get<string>('CHECK24_API_BASE_URL') ??
      'https://supplyapistaging.ferienwohnung.check24-test.de/api/v2';

    this.http = axios.create({
      baseURL: baseURL.replace(/\/$/, ''),
      timeout: 60_000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    this.http.interceptors.request.use((req) => {
      if (this.token) {
        req.headers.Authorization = `Bearer ${this.token}`;
      }
      return req;
    });
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  async ping(): Promise<{ message?: string }> {
    const { data } = await this.http.get('/ping');
    return data;
  }

  async listProperties(limit = 50, offset = 0): Promise<Check24Property[]> {
    const { data } = await this.http.get<Check24Property[]>('/properties', {
      params: { limit, offset },
    });
    return data ?? [];
  }

  async getProperty(propertyId: string): Promise<Check24Property> {
    const { data } = await this.http.get<Check24Property>(
      `/properties/${encodeURIComponent(propertyId)}`,
    );
    return data;
  }

  async pushProperties(properties: Check24Property[]): Promise<unknown> {
    // Supply API v2 expects { properties: Property[] }, not a bare array.
    const { data } = await this.http.post('/properties', { properties });
    return data;
  }

  async deleteProperty(propertyId: string): Promise<unknown> {
    const { data } = await this.http.delete(
      `/properties/${encodeURIComponent(propertyId)}`,
    );
    return data;
  }

  async getAvailabilities(propertyId: string): Promise<Check24Availability[]> {
    const { data } = await this.http.get<Check24Availability[]>(
      `/properties/${encodeURIComponent(propertyId)}/availability`,
    );
    return data ?? [];
  }

  async pushAvailability(
    propertyId: string,
    availability: Check24Availability[],
  ): Promise<unknown> {
    const { data } = await this.http.post(
      `/properties/${encodeURIComponent(propertyId)}/availability`,
      availability,
    );
    return data;
  }

  async getRates(propertyId: string): Promise<Check24Rate | Check24Rate[]> {
    const { data } = await this.http.get(
      `/properties/${encodeURIComponent(propertyId)}/rates`,
    );
    return data;
  }

  async pushRates(
    propertyId: string,
    rates: Check24Rate | Check24Rate[],
  ): Promise<unknown> {
    // Supply API v2 expects a single Rate object (not an array).
    const payload = Array.isArray(rates) ? rates[0] : rates;
    const { data } = await this.http.post(
      `/properties/${encodeURIComponent(propertyId)}/rates`,
      payload,
    );
    return data;
  }

  async listBookings(params?: {
    bookingId?: string;
    propertyId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<Check24Booking[]> {
    const { data } = await this.http.get<Check24Booking[]>('/bookings', {
      params,
    });
    return data ?? [];
  }

  async getBooking(bookingId: string): Promise<Check24Booking> {
    const { data } = await this.http.get<Check24Booking>(
      `/bookings/${encodeURIComponent(bookingId)}`,
    );
    return data;
  }

  async acceptBooking(bookingId: string): Promise<unknown> {
    const { data } = await this.http.post(
      `/bookings/${encodeURIComponent(bookingId)}/book`,
    );
    return data;
  }

  async declineBooking(
    bookingId: string,
    payload: { declineReason?: string; declineMessage?: string },
  ): Promise<unknown> {
    const { data } = await this.http.post(
      `/bookings/${encodeURIComponent(bookingId)}/decline`,
      payload,
    );
    return data;
  }

  async registerBookingWebhook(
    registration: Check24WebhookRegistration,
  ): Promise<unknown> {
    const { data } = await this.http.post('/bookings/webhook', registration);
    return data;
  }

  async deleteBookingWebhook(): Promise<unknown> {
    const { data } = await this.http.delete('/bookings/webhook');
    return data;
  }

  describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const ax = error as AxiosError;
      const body = ax.response?.data;
      const detail =
        typeof body === 'string'
          ? body
          : body
            ? JSON.stringify(body).slice(0, 800)
            : ax.message;
      return `CHECK24 HTTP ${ax.response?.status ?? '?'}: ${detail}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
