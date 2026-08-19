import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import {
  HostawayCalendarDay,
  HostawayCreateReservationResult,
  HostawayGuestCharge,
  HostawayListResponse,
  HostawayListing,
  HostawayMessageTemplate,
  HostawayPriceDetails,
  HostawayReservation,
  HostawaySingleResponse,
  HostawayTokenResponse,
  HostawayUnifiedWebhook,
} from './hostaway.types';

@Injectable()
export class HostawayClient {
  private readonly logger = new Logger(HostawayClient.name);
  private readonly http: AxiosInstance;
  private readonly accountId: string;
  private readonly apiSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.accountId = this.config.getOrThrow<string>('HOSTAWAY_ACCOUNT_ID');
    this.apiSecret = this.config.getOrThrow<string>('HOSTAWAY_API_SECRET');
    const baseURL =
      this.config.get<string>('HOSTAWAY_API_BASE_URL') ??
      'https://api.hostaway.com/v1';

    this.http = axios.create({
      baseURL,
      timeout: 30000,
      headers: { 'Cache-Control': 'no-cache' },
    });

    this.http.interceptors.request.use(async (req) => {
      const token = await this.getAccessToken();
      req.headers.Authorization = `Bearer ${token}`;
      return req;
    });
  }

  async getAccessToken(): Promise<string> {
    const cached = await this.prisma.hostawayToken.findFirst({
      orderBy: { createdAt: 'desc' },
    });

    if (cached && cached.expiresAt > new Date(Date.now() + 60_000)) {
      return cached.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.accountId,
      client_secret: this.apiSecret,
      scope: 'general',
    });

    const { data } = await axios.post<HostawayTokenResponse>(
      `${this.config.get('HOSTAWAY_API_BASE_URL') ?? 'https://api.hostaway.com/v1'}/accessTokens`,
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );

    await new Promise((r) => setTimeout(r, 1100));

    const expiresAt = new Date(Date.now() + data.expires_in * 1000);
    await this.prisma.hostawayToken.create({
      data: {
        accessToken: data.access_token,
        expiresAt,
      },
    });

    this.logger.log('Hostaway access token refreshed');
    return data.access_token;
  }

  async getListings(limit = 100, offset = 0): Promise<HostawayListing[]> {
    const { data } = await this.http.get<HostawayListResponse<HostawayListing>>(
      '/listings',
      { params: { limit, offset } },
    );
    return data.result ?? [];
  }

  async getAllListings(): Promise<HostawayListing[]> {
    const all: HostawayListing[] = [];
    const limit = 100;
    let offset = 0;
    for (;;) {
      const batch = await this.getListings(limit, offset);
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async getListing(id: number): Promise<HostawayListing> {
    const { data } = await this.http.get<HostawaySingleResponse<HostawayListing>>(
      `/listings/${id}`,
    );
    return data.result;
  }

  async getListingUnits(listingMapId: number) {
    const { data } = await this.http.get<
      HostawayListResponse<import('./hostaway.types').HostawayListingUnit>
    >(`/listingUnits/${listingMapId}`);
    return data.result ?? [];
  }

  async getConversationMessages(conversationId: number, limit = 20) {
    const { data } = await this.http.get<
      HostawayListResponse<import('./hostaway.types').HostawayConversationMessage>
    >(`/conversations/${conversationId}/messages`, {
      params: { limit, offset: 0 },
    });
    return data.result ?? [];
  }

  async getCalendar(
    listingId: number,
    startDate: string,
    endDate: string,
  ): Promise<HostawayCalendarDay[]> {
    const { data } = await this.http.get<
      HostawayListResponse<HostawayCalendarDay>
    >(`/listings/${listingId}/calendar`, {
      params: { startDate, endDate },
    });
    return data.result ?? [];
  }

  async getReservations(params: {
    limit?: number;
    offset?: number;
    arrivalStartDate?: string;
    arrivalEndDate?: string;
  }): Promise<HostawayReservation[]> {
    const { data } = await this.http.get<
      HostawayListResponse<HostawayReservation>
    >('/reservations', { params });
    return data.result ?? [];
  }

  async getAllReservations(params: {
    arrivalStartDate?: string;
    arrivalEndDate?: string;
  }): Promise<HostawayReservation[]> {
    const all: HostawayReservation[] = [];
    const limit = 100;
    let offset = 0;
    for (;;) {
      const batch = await this.getReservations({ ...params, limit, offset });
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return all;
  }

  async getReservation(id: number): Promise<HostawayReservation> {
    const { data } = await this.http.get<
      HostawaySingleResponse<HostawayReservation>
    >(`/reservations/${id}`);
    return data.result;
  }

  async findConversationByReservation(
    reservationId: number,
  ): Promise<number | null> {
    const { data } = await this.http.get<
      HostawayListResponse<{ id: number; reservationId: number }>
    >('/conversations', {
      params: { reservationId, limit: 1 },
    });
    return data.result?.[0]?.id ?? null;
  }

  async sendConversationMessage(
    conversationId: number,
    body: string,
    communicationType: 'channel' | 'email' = 'channel',
  ): Promise<number> {
    const { data } = await this.http.post<
      HostawaySingleResponse<{ id: number }>
    >(`/conversations/${conversationId}/messages`, {
      body,
      communicationType,
    });
    return data.result.id;
  }

  async getMessageTemplates(params?: {
    reservationId?: number;
    listingMapId?: number;
  }): Promise<HostawayMessageTemplate[]> {
    const { data } = await this.http.get<
      HostawayListResponse<HostawayMessageTemplate>
    >('/messageTemplates', { params });
    return data.result ?? [];
  }

  async getReservationMessageTemplates(
    reservationId: number,
  ): Promise<HostawayMessageTemplate[]> {
    const { data } = await this.http.get<
      HostawayListResponse<HostawayMessageTemplate>
    >(`/reservations/${reservationId}/messageTemplates`);
    return data.result ?? [];
  }

  async listUnifiedWebhooks(): Promise<HostawayUnifiedWebhook[]> {
    const { data } = await this.http.get<
      HostawayListResponse<HostawayUnifiedWebhook>
    >('/webhooks/unifiedWebhooks');
    return data.result ?? [];
  }

  async createUnifiedWebhook(params: {
    url: string;
    login?: string;
    password?: string;
    alertingEmailAddress?: string;
  }): Promise<HostawayUnifiedWebhook> {
    const { data } = await this.http.post<
      HostawaySingleResponse<HostawayUnifiedWebhook>
    >('/webhooks/unifiedWebhooks', {
      isEnabled: 1,
      url: params.url,
      login: params.login ?? null,
      password: params.password ?? null,
      alertingEmailAddress: params.alertingEmailAddress ?? null,
    });
    return data.result;
  }

  async calculatePriceDetails(
    listingId: number,
    params: {
      startingDate: string;
      endingDate: string;
      numberOfGuests: number;
    },
  ): Promise<HostawayPriceDetails> {
    const { data } = await this.http.post<
      HostawaySingleResponse<HostawayPriceDetails>
    >(`/listings/${listingId}/calendar/priceDetails`, {
      startingDate: params.startingDate,
      endingDate: params.endingDate,
      numberOfGuests: params.numberOfGuests,
      version: 2,
    });
    return data.result;
  }

  async createReservation(
    payload: Record<string, unknown>,
    forceOverbooking = false,
  ): Promise<HostawayCreateReservationResult> {
    const { data } = await this.http.post<
      HostawaySingleResponse<HostawayCreateReservationResult>
    >(`/reservations${forceOverbooking ? '?forceOverbooking=1' : ''}`, payload);
    return data.result;
  }

  async updateReservation(
    reservationId: number,
    payload: Record<string, unknown>,
    forceOverbooking = false,
  ): Promise<HostawayReservation> {
    const { data } = await this.http.put<
      HostawaySingleResponse<HostawayReservation>
    >(
      `/reservations/${reservationId}${forceOverbooking ? '?forceOverbooking=1' : ''}`,
      payload,
    );
    return data.result;
  }

  async cancelReservation(reservationId: number): Promise<HostawayReservation> {
    return this.updateReservation(reservationId, { status: 'cancelled' });
  }

  async getGuestCharges(reservationId: number): Promise<HostawayGuestCharge[]> {
    const { data } = await this.http.get<
      HostawayListResponse<HostawayGuestCharge>
    >('/guestPayments/charges', {
      params: { reservationId },
    });
    return data.result ?? [];
  }

  async createOfflineCharge(
    reservationId: number,
    payload: {
      title: string;
      description?: string;
      amount: number;
      paymentMethod: string;
      status: 'paid' | 'due';
      scheduledDate?: string;
    },
  ): Promise<HostawayGuestCharge> {
    const { data } = await this.http.post<
      HostawaySingleResponse<HostawayGuestCharge>
    >(`/guestPayments/charges/${reservationId}`, {
      ...payload,
      scheduledDate:
        payload.scheduledDate ??
        new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    return data.result;
  }

  /**
   * Best-effort cancel of a guest charge created by this middleware.
   * Hostaway may reject updates on already-paid charges — callers should
   * continue local undo and surface a manual Hostaway follow-up if this fails.
   */
  async cancelGuestCharge(
    reservationId: number,
    chargeId: number,
  ): Promise<HostawayGuestCharge> {
    const { data } = await this.http.put<
      HostawaySingleResponse<HostawayGuestCharge>
    >(`/guestPayments/charges/${reservationId}/${chargeId}`, {
      status: 'cancelled',
    });
    return data.result;
  }
}
