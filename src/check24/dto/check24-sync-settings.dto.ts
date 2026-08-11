import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateCheck24SyncSettingsDto {
  @IsOptional()
  @IsBoolean()
  autoSyncEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoSyncContent?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  intervalMinutes?: number;
}
