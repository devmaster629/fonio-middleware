import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { parseQueryBoolean } from '../../common/utils/query-boolean.util';

export class AvailabilityQueryDto {
  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsString()
  checkIn!: string;

  @IsString()
  checkOut!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  guests!: number;

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

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  availableOnly?: boolean;

  /**
   * Same dates, other properties (exclude `city`). Ranked by Hostaway coordinates.
   * Use after the requested city has no availability and the guest wants surroundings.
   */
  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  nearby?: boolean;

  /** When true, refreshes stale calendars from Hostaway (slower). Default: cache-only for fast phone responses. */
  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  liveRefresh?: boolean;
}
