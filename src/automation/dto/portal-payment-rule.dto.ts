import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

function optionalNullableInt({ value }: { value: unknown }) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

export class UpdatePortalPaymentRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelMatchers?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  portalAssumedPaidPercent?: number;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  treatAsPaidUntilDaysBeforeArrival?: number | null;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  treatAsPaidUntilDaysAfterDeparture?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  hostDuePercent?: number;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  hostDueByDaysBeforeArrival?: number | null;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  hostDueByDaysAfterDeparture?: number | null;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(90)
  overdueGraceDays?: number | null;

  @IsOptional()
  @IsBoolean()
  autoRequestInbox?: boolean;

  @IsOptional()
  @IsBoolean()
  skipUnpaidReminder?: boolean;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(100)
  depositDuePercent?: number | null;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  depositDueDaysAfterBooking?: number | null;

  @IsOptional()
  @IsBoolean()
  autoRequestOnImport?: boolean;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentDeadlineDays?: number | null;

  @IsOptional()
  @IsBoolean()
  autoSendGuestPaymentLink?: boolean;

  @IsOptional()
  @Transform(optionalNullableInt)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsInt()
  @Min(0)
  @Max(90)
  guestReminderDaysBeforeDeadline?: number | null;

  @IsOptional()
  @IsBoolean()
  autoCancelIfUnpaid?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
