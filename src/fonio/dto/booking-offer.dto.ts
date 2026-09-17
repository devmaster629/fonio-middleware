import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { normalizeDateInput } from '../../common/utils/date-input.util';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class BookingOfferDto {
  @Type(() => Number)
  @IsInt()
  listingId!: number;

  @Transform(({ value }) => normalizeDateInput(value))
  @IsString()
  checkIn!: string;

  @Transform(({ value }) => normalizeDateInput(value))
  @IsString()
  checkOut!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  guests!: number;

  @Transform(trimString)
  @IsString()
  @MinLength(2)
  guestFirstName!: string;

  @Transform(trimString)
  @IsString()
  @MinLength(2)
  guestLastName!: string;

  @Transform(trimString)
  @IsEmail()
  guestEmail!: string;

  /** Real callback number — required before creating a Hostaway inquiry. */
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  phone!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  note?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pets?: number;
}
