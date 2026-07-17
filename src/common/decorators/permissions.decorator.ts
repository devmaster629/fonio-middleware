import { SetMetadata } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';

export const PERMISSIONS_KEY = 'admin_permissions';

/** Require at least one of the listed permissions (OR). Super Admin always passes. */
export const Permissions = (...permissions: AdminPermission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
