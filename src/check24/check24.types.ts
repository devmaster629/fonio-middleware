export type Check24AvailabilityStatus = 'open' | 'closed';

export interface Check24ReferenceId {
  reference: string;
  id: string;
}

export interface Check24Image {
  url: string;
  category?: string;
}

export interface Check24Amenity {
  name: string;
  free?: boolean;
  onRequest?: boolean;
  value?: string;
}

export interface Check24CancellationCondition {
  appliesUntilDaysBeforeArrival: number;
  percentage: number;
}

export interface Check24PaymentCondition {
  paymentMethods: string[];
  dueDate: 'upon_booking' | 'upon_arrival' | 'custom';
  paymentSchedule?: Array<{ daysBeforeArrival: number; percentage: number }>;
}

export interface Check24Property {
  propertyId: string;
  referenceIds: Check24ReferenceId[];
  name?: string;
  description?: string | null;
  type?: string;
  status?: 'active' | 'inactive';
  street?: string | null;
  city: string;
  zip?: string | null;
  countryCode?: string;
  latitude: number;
  longitude: number;
  phone?: string | null;
  email?: string | null;
  hostType: 'private' | 'professional';
  hostName?: string | null;
  spokenLanguages?: string[];
  checkinBegin?: string | null;
  checkinEnd?: string | null;
  checkoutBegin?: string | null;
  checkoutEnd?: string | null;
  checkinInstructions?: string | null;
  termsConditions: string;
  enquiryOnly?: boolean;
  maxOccupancy: number;
  maxAdults: number;
  maxChildren?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareMeters?: number | null;
  images?: Check24Image[];
  amenities?: Check24Amenity[];
  policies?: Array<{ name: string; content: string }>;
  pricingMethod: 'standard' | 'los';
  currencyCode?: string;
  defaultCancellation: Check24CancellationCondition[];
  defaultPayment: Check24PaymentCondition[];
  groupId?: string | null;
  partnerDisplayName?: string | null;
  testProperty?: boolean;
  internalPartnerId?: string | null;
}

export interface Check24Availability {
  dateFrom: string;
  dateTo: string;
  availability: Check24AvailabilityStatus;
  minStay?: number;
  maxStay?: number;
  checkinPossible?: boolean;
  checkoutPossible?: boolean;
}

export interface Check24StandardPricing {
  dateFrom: string;
  dateTo: string;
  dailyPrice: number;
  weekendPrice?: number;
}

export interface Check24Rate {
  currencyCode: string;
  vat?: number;
  standardPricing?: Check24StandardPricing[];
}

export interface Check24Guest {
  title?: string;
  firstName?: string;
  lastName?: string;
  street?: string;
  zip?: string;
  city?: string;
  countryCode?: string;
  email?: string;
  phone?: string;
}

export interface Check24Booker {
  firstName?: string;
  lastName?: string;
}

export interface Check24Booking {
  bookingId: string;
  propertyId: string;
  parkId?: string | null;
  status: 'requested' | 'booked' | 'declined' | 'canceled' | 'failed' | string;
  createdAt?: string;
  modifiedAt?: string;
  dateFrom: string;
  dateTo: string;
  arrivalTime?: string | null;
  numberAdults?: number;
  children?: { ages?: number[] } | number[] | null;
  guest?: Check24Guest | null;
  booker?: Check24Booker | null;
  comments?: string | null;
  currencyCode?: string | null;
  totalPrice?: number | null;
  commission?: number | null;
  tax?: number | null;
  paymentMethod?: string | null;
  hostChatLink?: string | null;
  declineReason?: string | null;
  declineMessage?: string | null;
}

export interface Check24WebhookNotification {
  bookingId: string;
  propertyId?: string;
  status?: string;
}

export interface Check24WebhookRegistration {
  url: string;
  authorization?: {
    username: string;
    password: string;
  };
}
