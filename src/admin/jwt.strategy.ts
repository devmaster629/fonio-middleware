import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { AdminPermission, AdminRole } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from './permissions.service';

export type AdminRequestUser = {
  id: string;
  email: string;
  role: AdminRole;
  permissions: AdminPermission[];
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: {
    sub: string;
    email: string;
    role: string;
  }): Promise<AdminRequestUser | null> {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.isActive) {
      return null;
    }
    const permissions = await this.permissions.getPermissionsForRole(user.role);
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      permissions,
    };
  }
}
