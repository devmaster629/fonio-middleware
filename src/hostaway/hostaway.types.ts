export interface HostawayTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface HostawayListResponse<T> {
  status: string;
  result: T[];
  count?: number;
}

export interface HostawaySingleResponse<T> {
  status: string;
  result: T;
}

export interface HostawayListing {
  id: number;
  name: string;
  city: string | null;
  state: string | null;
  personCapacity: number;
  bedroomsNumber: number | null;
  roomType: string | null;
  specialStatus: string | null;
  listingTags?: { id: number; name: string }[];
  listingAmenities?: { amenityId: number; amenityName: string }[];
}

export interface HostawayListingUnit {
  id: number;
  name: string;
  listingMapIdUnit?: number | string | null;
}

export interface HostawayCalendarDay {
  date: string;
  isAvailable: number;
  minimumStay: number;
  price: number;
}

export interface HostawayReservation {
  id: number;
  listingMapId: number;
  arrivalDate: string;
  departureDate: string;
  numberOfGuests: number;
  adults: number | null;
  children: number | null;
  pets: number | null;
  status: string;
  guestName: string;
  guestFirstName?: string | null;
  guestLastName?: string | null;
  guestEmail: string | null;
  phone: string | null;
  totalPrice?: number | null;
}

export interface HostawayConversation {
  id: number;
  listingMapId: number;
  reservationId: number;
}

export interface HostawayConversationMessage {
  id: number;
  body: string;
  emailFormatted?: string | null;
  communicationType: string;
  insertedOn?: string;
  isIncoming?: number;
}

export interface HostawayUnifiedWebhook {
  id: number;
  isEnabled: number;
  url: string;
  login: string | null;
  password: string | null;
  alertingEmailAddress: string | null;
}

export interface HostawayPriceComponent {
  listingFeeSettingId?: number | null;
  type: string;
  name: string;
  title: string;
  alias?: string | null;
  quantity?: number | null;
  value: number;
  total: number;
  isIncludedInTotalPrice: number;
  isOverriddenByUser?: number;
  isMandatory?: number | null;
  isDeleted?: number;
}

export interface HostawayPriceDetails {
  totalPrice: number;
  components: HostawayPriceComponent[];
}

export interface HostawayCreateReservationResult {
  id: number;
  listingMapId: number;
  arrivalDate: string;
  departureDate: string;
  status: string;
  totalPrice?: number;
}

export interface HostawayGuestCharge {
  id: number;
  reservationId?: number;
  title?: string;
  amount?: number;
  currency?: string;
  status?: string;
  paymentMethod?: string;
  chargeDate?: string | null;
  scheduledDate?: string | null;
}
