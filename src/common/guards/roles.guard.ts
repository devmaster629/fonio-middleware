import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Legacy minimum-rank gate. Prefer PermissionsGuard for new endpoints.
 * BACK_OFFICE is intentionally below EDITOR so @Roles(EDITOR) does not
 * grant technical editor powers.
 */
const ROLE_RANK: Record<AdminRole, number> = {
  VIEWER: 0,
  BACK_OFFICE: 0,
  EDITOR: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { role: AdminRole };
    }>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('Admin authentication required');
    }

    const userRank = ROLE_RANK[user.role] ?? -1;
    const minRequired = Math.min(...required.map((r) => ROLE_RANK[r]));
    if (userRank < minRequired) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
