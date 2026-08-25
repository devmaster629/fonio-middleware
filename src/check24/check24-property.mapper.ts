import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Listing } from '@prisma/client';
import { HostawayListing } from '../hostaway/hostaway.types';
import { mapHostawayAmenityName } from './check24-amenity.map';
import {
  Check24Amenity,
  Check24Image,
  Check24Property,
} from './check24.types';

@Injectable()
export class Check24PropertyMapper {
  constructor(private readonly config: ConfigService) {}

  propertyIdForHostaway(hostawayId: number): string {
    const prefix = this.config.get<string>('CHECK24_PROPERTY_ID_PREFIX') ?? 'ha';
    return `${prefix}-${hostawayId}`;
  }

  mapListing(local: Listing, remote: HostawayListing): Check24Property {
    const propertyId = this.propertyIdForHostaway(local.hostawayId);
    const maxOccupancy = Math.max(1, local.personCapacity || remote.personCapacity || 1);
    const lat = this.toNumber(local.lat ?? remote.lat ?? remote.latitude);
    const lng = this.toNumber(local.lng ?? remote.lng ?? remote.longitude);
    if (lat == null || lng == null) {
      throw new Error(
        `Listing ${local.hostawayId} is missing latitude/longitude required by CHECK24`,
      );
    }

    const city = (local.city || remote.city || '').trim();
    if (!city) {
      throw new Error(`Listing ${local.hostawayId} is missing city required by CHECK24`);
    }

    const terms =
      this.config.get<string>('CHECK24_TERMS_URL') ??
      'https://brainions.digital/agb';
    const hostType =
      (this.config.get<string>('CHECK24_HOST_TYPE') as 'private' | 'professional') ||
      'professional';
    const testProperty =
      (this.config.get<string>('CHECK24_TEST_PROPERTY') ?? 'true').toLowerCase() !==
      'false';
    const enquiryOnly =
      (this.config.get<string>('CHECK24_ENQUIRY_ONLY') ?? 'false').toLowerCase() ===
      'true';

    const countryCode = this.normalizeCountry(
      remote.countryCode ?? remote.country ?? 'DE',
    );

    const images = this.mapImages(remote);
    if (images.length < 3) {
      throw new Error(
        `Listing ${local.hostawayId} needs at least 3 images for CHECK24 (found ${images.length})`,
      );
    }

    const payload: Check24Property = {
      propertyId,
      // Optional cross-OTA matching only. Empty is valid for newly created supply.
      referenceIds: [],
      name: local.name || remote.name,
      description: remote.description || undefined,
      type: this.mapPropertyType(local.name, local.roomType ?? remote.roomType),
      status: local.isBookable ? 'active' : 'inactive',
      street: remote.street ?? remote.address ?? undefined,
      city,
      zip: remote.zipcode ?? undefined,
      countryCode,
      latitude: lat,
      longitude: lng,
      email: this.config.get<string>('CHECK24_CONTACT_EMAIL') || undefined,
      hostType,
      hostName:
        remote.contactName ??
        this.config.get<string>('CHECK24_HOST_NAME') ??
        'brainions Vermietung',
      spokenLanguages: ['de', 'en'],
      ...this.mapCheckTimes(remote),
      termsConditions: terms,
      enquiryOnly,
      maxOccupancy,
      maxAdults: maxOccupancy,
      maxChildren: maxOccupancy,
      bedrooms: local.bedroomsNumber ?? remote.bedroomsNumber ?? undefined,
      bathrooms: remote.bathroomsNumber ?? undefined,
      squareMeters: remote.squareMeters ?? undefined,
      images,
      amenities: this.mapAmenities(local, remote),
      policies: this.mapPolicies(local, remote),
      pricingMethod: 'standard',
      currencyCode: 'EUR',
      defaultCancellation: [
        {
          appliesUntilDaysBeforeArrival: Number(
            this.config.get('CHECK24_CANCEL_FREE_DAYS') ?? 14,
          ),
          percentage: 0,
        },
        {
          appliesUntilDaysBeforeArrival: 0,
          percentage: 100,
        },
      ],
      defaultPayment: [
        {
          paymentMethods: ['bank_transfer', 'creditcard_visa', 'creditcard_master'],
          dueDate: 'upon_booking',
        },
      ],
      partnerDisplayName:
        this.config.get<string>('CHECK24_PARTNER_DISPLAY_NAME') ??
        'brainions Vermietung',
      testProperty,
      internalPartnerId: String(local.hostawayId),
    };

    const phone =
      remote.phone ?? this.config.get<string>('CHECK24_CONTACT_PHONE') ?? undefined;
    if (phone) payload.phone = phone;

    if (local.parentHostawayId) {
      payload.groupId = `group-${local.parentHostawayId}`;
    }

    return payload;
  }

  private mapImages(remote: HostawayListing): Check24Image[] {
    // CHECK24 image category enum (Supply API v2)
    const categories = [
      'exterior_view',
      'room',
      'kitchen',
      'bathroom',
      'view',
      'surrounding',
      'terrace',
      'other',
    ];
    const images = (remote.listingImages ?? [])
      .map((img, index) => {
        const url = img.url?.trim();
        if (!url) return null;
        return {
          url,
          category: categories[Math.min(index, categories.length - 1)],
        } as Check24Image;
      })
      .filter((x): x is Check24Image => Boolean(x));
    return images.slice(0, 50);
  }

  /** CHECK24 only accepts these policy names (not free-form "house_rules"). */
  private mapPolicies(
    local: Listing,
    remote: HostawayListing,
  ): Array<{ name: string; content: string }> | undefined {
    const policies: Array<{ name: string; content: string }> = [];
    const rules = remote.houseRules?.trim();
    if (rules) {
      // General house rules → fees/rules bucket (valid enum value).
      policies.push({ name: 'policies_fees', content: rules });
    }
    if (local.petsAllowed) {
      policies.push({
        name: 'policies_pets',
        content: 'Pets are allowed. Please confirm details with the host.',
      });
    }
    return policies.length ? policies : undefined;
  }

  private mapAmenities(local: Listing, remote: HostawayListing): Check24Amenity[] {
    const out: Check24Amenity[] = [];
    const seen = new Set<string>();

    for (const a of remote.listingAmenities ?? []) {
      const mapped = mapHostawayAmenityName(a.amenityName);
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push({ name: mapped, free: true, onRequest: false });
    }

    if (local.petsAllowed && !seen.has('pets_allowed')) {
      out.push({ name: 'pets_allowed', free: true, onRequest: false });
    }

    return out;
  }

  private mapPropertyType(
    name: string | null | undefined,
    roomType: string | null | undefined,
  ): string {
    const t = `${name ?? ''} ${roomType ?? ''}`.toLowerCase();
    if (t.includes('studio')) return 'studio';
    if (t.includes('villa')) return 'villa';
    if (t.includes('chalet')) return 'chalet';
    if (t.includes('bungalow')) return 'bungalow';
    if (t.includes('apartment') || t.includes('flat') || t.includes('zimmer')) {
      return 'apartment';
    }
    if (t.includes('house') || t.includes('haus') || t.includes('home')) {
      return 'holiday_home';
    }
    if (t.includes('room')) return 'room';
    return 'apartment';
  }

  private normalizeCountry(value: string): string {
    const c = value.trim().toLowerCase();
    if (c === 'germany' || c === 'deutschland') return 'de';
    if (c.length === 2) return c;
    return 'de';
  }

  private toNumber(value: unknown): number | null {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * CHECK24 requires HH:MM in 00:00–23:59 with begin < end.
   * Hostaway sometimes stores flexible late check-in as 24–26 → that caused HTTP 500.
   */
  private mapCheckTimes(remote: HostawayListing): {
    checkinBegin: string;
    checkinEnd: string;
    checkoutBegin: string;
    checkoutEnd: string;
  } {
    const checkinBegin = this.toTime(remote.checkInTimeStart) ?? '15:00';
    let checkinEnd = this.toTime(remote.checkInTimeEnd) ?? '22:00';
    if (!this.isBefore(checkinBegin, checkinEnd)) {
      checkinEnd = '22:00';
      if (!this.isBefore(checkinBegin, checkinEnd)) {
        return {
          checkinBegin: '15:00',
          checkinEnd: '22:00',
          checkoutBegin: '08:00',
          checkoutEnd: this.toTime(remote.checkOutTime) ?? '11:00',
        };
      }
    }

    const checkoutBegin = '08:00';
    let checkoutEnd = this.toTime(remote.checkOutTime) ?? '11:00';
    if (!this.isBefore(checkoutBegin, checkoutEnd)) {
      checkoutEnd = '11:00';
    }

    return { checkinBegin, checkinEnd, checkoutBegin, checkoutEnd };
  }

  /** Parse to HH:MM, clamping hours ≥ 24 down to 23:59. */
  private toTime(value: unknown): string | null {
    if (value == null || value === '') return null;
    let h: number;
    let m: number;
    if (typeof value === 'number' && Number.isFinite(value)) {
      h = Math.floor(value);
      m = Math.round((value - h) * 60);
    } else {
      const match = String(value).match(/^(\d{1,2})(?::(\d{2}))?/);
      if (!match) return null;
      h = Number(match[1]);
      m = Number(match[2] ?? 0);
    }
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h > 23 || (h === 23 && m > 59)) {
      return '23:59';
    }
    if (h < 0 || m < 0 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  private isBefore(a: string, b: string): boolean {
    return this.minutesOf(a) < this.minutesOf(b);
  }

  private minutesOf(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }
}
