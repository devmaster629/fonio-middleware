import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-users.dto';

const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MANAGED_ROLES = new Set<AdminRole>([
  AdminRole.BACK_OFFICE,
  AdminRole.ADMIN,
  AdminRole.SUPER_ADMIN,
]);

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.adminUser.findMany({
      select: PUBLIC_USER_SELECT,
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  async create(dto: CreateAdminUserDto) {
    this.assertManagedRole(dto.role);
    const existing = await this.prisma.adminUser.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already in use');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    return this.prisma.adminUser.create({
      data: {
        email: dto.email,
        passwordHash,
        role: dto.role,
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  async update(id: string, dto: UpdateAdminUserDto, actorId: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.email && dto.email !== user.email) {
      const taken = await this.prisma.adminUser.findUnique({
        where: { email: dto.email },
      });
      if (taken) {
        throw new ConflictException('Email already in use');
      }
    }

    if (dto.role !== undefined && dto.role !== user.role) {
      this.assertManagedRole(dto.role);
      await this.assertCanChangeSuperAdminRole(user, dto.role, actorId);
    }

    if (dto.isActive === false) {
      await this.assertCanDeactivate(user, actorId);
    }

    const data: {
      email?: string;
      passwordHash?: string;
      role?: AdminRole;
      isActive?: boolean;
    } = {};

    if (dto.email) data.email = dto.email;
    if (dto.password) data.passwordHash = await bcrypt.hash(dto.password, 12);
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    return this.prisma.adminUser.update({
      where: { id },
      data,
      select: PUBLIC_USER_SELECT,
    });
  }

  async remove(id: string, actorId: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.assertCanDeactivate(user, actorId);

    return this.prisma.adminUser.update({
      where: { id },
      data: { isActive: false },
      select: PUBLIC_USER_SELECT,
    });
  }

  private async assertCanDeactivate(
    user: { id: string; role: AdminRole },
    actorId: string,
  ) {
    if (user.id === actorId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (user.role === AdminRole.SUPER_ADMIN) {
      const superAdminCount = await this.countActiveSuperAdmins();
      if (superAdminCount <= 1) {
        throw new ForbiddenException('Cannot remove the last super admin');
      }
    }
  }

  private async assertCanChangeSuperAdminRole(
    user: { id: string; role: AdminRole },
    newRole: AdminRole,
    actorId: string,
  ) {
    if (user.role !== AdminRole.SUPER_ADMIN) return;
    if (newRole === AdminRole.SUPER_ADMIN) return;

    const superAdminCount = await this.countActiveSuperAdmins();
    if (superAdminCount <= 1 && user.id === actorId) {
      throw new ForbiddenException('Cannot demote the last super admin');
    }
    if (superAdminCount <= 1) {
      throw new ForbiddenException('Cannot demote the last super admin');
    }
  }

  private countActiveSuperAdmins() {
    return this.prisma.adminUser.count({
      where: { role: AdminRole.SUPER_ADMIN, isActive: true },
    });
  }

  private assertManagedRole(role: AdminRole) {
    if (!MANAGED_ROLES.has(role)) {
      throw new BadRequestException(
        'Role must be BACK_OFFICE, ADMIN or SUPER_ADMIN',
      );
    }
  }
}
