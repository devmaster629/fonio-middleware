import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { normalizeOptionalInput } from '../../common/utils/optional-input.util';

function parseRequiredInt(value: unknown): number {
  if (value === '' || value === null || value === undefined) {
    return Number.NaN;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

export class SendCheckinInfoDto {
  @Transform(({ value }) => parseRequiredInt(value))
  @IsInt()
  reservationId!: number;

  @IsString()
  @IsNotEmpty()
  verificationToken!: string;

  @IsOptional()
  @Transform(({ value }) => normalizeOptionalInput(value))
  @IsString()
  callId?: string;
}
