import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { LogLevel } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from './permissions.service';

@Injectable()
export class AdminAuthService {
  private readonly loginAttempts = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditLogService,
    private readonly permissions: PermissionsService,
  ) {}

  async login(email: string, password: string, ip?: string) {
    this.assertLoginRateLimit(email.toLowerCase());

    const user = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      await this.recordFailedLogin(email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await this.recordFailedLogin(email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.loginAttempts.delete(email.toLowerCase());

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    await this.audit.log({
      level: LogLevel.SECURITY,
      source: 'admin',
      action: 'login_success',
      metadata: { adminId: user.id, role: user.role },
      ip,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        permissions: await this.permissions.getPermissionsForRole(user.role),
      },
    };
  }

  private assertLoginRateLimit(email: string) {
    const now = Date.now();
    const entry = this.loginAttempts.get(email);
    if (entry && entry.resetAt > now && entry.count >= 10) {
      throw new HttpException(
        'Too many login attempts. Try again in a few minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordFailedLogin(email: string, ip?: string) {
    const key = email.toLowerCase();
    const now = Date.now();
    const entry = this.loginAttempts.get(key);
    const next = entry && entry.resetAt > now
      ? { count: entry.count + 1, resetAt: entry.resetAt }
      : { count: 1, resetAt: now + 15 * 60_000 };
    this.loginAttempts.set(key, next);

    await this.audit.log({
      level: LogLevel.SECURITY,
      source: 'admin',
      action: 'login_failed',
      metadata: { emailHash: email ? email.slice(0, 3) + '***' : undefined },
      ip,
    });
  }
}
