import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPermission, AdminRole } from '@prisma/client';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminPermission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<{
      user?: {
        role?: AdminRole;
        permissions?: AdminPermission[];
      };
    }>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('Admin authentication required');
    }
    if (user.role === AdminRole.SUPER_ADMIN) return true;

    const granted = new Set(user.permissions ?? []);
    const ok = required.some((p) => granted.has(p));
    if (!ok) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
