import { AdminPermission, AdminRole } from '@prisma/client';
import { ArrayUnique, IsArray, IsEnum, IsIn } from 'class-validator';

const CONFIGURABLE_ROLES = [
  AdminRole.BACK_OFFICE,
  AdminRole.ADMIN,
] as const;

export class UpdateRolePermissionsDto {
  @IsIn(CONFIGURABLE_ROLES)
  role!: AdminRole;

  @IsArray()
  @ArrayUnique()
  @IsEnum(AdminPermission, { each: true })
  permissions!: AdminPermission[];
}
