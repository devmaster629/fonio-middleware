import { Transform, Type } from 'class-transformer';
import { PaymentPlanFrequency } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

function optionalNullableNumber({ value }: { value: unknown }) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function optionalNullableDate({ value }: { value: unknown }) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return value;
}

export class UpdatePaymentPlanDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  installmentAmount?: number;

  @IsOptional()
  @IsEnum(PaymentPlanFrequency)
  frequency?: PaymentPlanFrequency;

  @IsOptional()
  @Transform(optionalNullableNumber)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  customIntervalDays?: number | null;

  @IsOptional()
  @Transform(optionalNullableNumber)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  nextDueAmount?: number | null;

  @IsOptional()
  @Transform(optionalNullableDate)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsDateString()
  nextDueAt?: string | null;

  @IsOptional()
  @Transform(optionalNullableNumber)
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  paidTowardPlan?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === null || value === '' ? null : value,
  )
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}
