import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { parseQueryBoolean } from '../../common/utils/query-boolean.util';

/**
 * Batch-check Friday–Sunday (or Fri+nights) weekends for a month or whole year.
 * Use when the caller says "a weekend in October" / "any weekend in 2027"
 * instead of inventing a single checkIn/checkOut.
 */
export class WeekendAvailabilityQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  /** 1–12. Omit to scan every weekend in `year` (returns only weekends with availability). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  guests!: number;

  /** Stay length in nights starting Friday. Default 2 = Fri→Sun. Use 3 for Fri→Mon. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  nights?: number;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  pets?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  bedrooms?: number;

  @IsOptional()
  @IsString()
  roomType?: string;

  /** Default true for phone: only weekends that have at least one open listing. */
  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  availableOnly?: boolean;

  /** Max weekends to return (after filtering). Default 8 — keeps voice replies short. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(53)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  liveRefresh?: boolean;
}
