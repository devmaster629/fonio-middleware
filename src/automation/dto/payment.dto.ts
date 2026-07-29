import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExternalPaymentSource } from '@prisma/client';

export class ManualPaymentIngestDto {
  @IsEnum(ExternalPaymentSource)
  source!: ExternalPaymentSource;

  @IsString()
  @IsNotEmpty()
  externalId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsString()
  payerName?: string;

  @IsOptional()
  @IsEmail()
  payerEmail?: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

export class PaymentAllocationDto {
  @Type(() => Number)
  @IsInt()
  reservationHostawayId!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ConfirmPaymentReviewDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  reservationHostawayId?: number;

  @IsOptional()
  @IsString()
  note?: string;

  /** When set (2+ lines), payment is split across multiple reservations. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations?: PaymentAllocationDto[];
}

export class SkipPaymentReviewDto {
  @IsOptional()
  @IsString()
  note?: string;
}
