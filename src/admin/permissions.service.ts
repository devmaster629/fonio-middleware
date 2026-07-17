import { Injectable } from '@nestjs/common';
import { AdminPermission, AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ADMIN_PERMISSION_CATALOG,
  defaultPermissionsForRole,
} from './permissions.catalog';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async seedDefaultsIfEmpty(): Promise<void> {
    const count = await this.prisma.rolePermission.count();
    if (count > 0) return;

    const rows: { role: AdminRole; permission: AdminPermission }[] = [];
    for (const role of Object.values(AdminRole)) {
      for (const permission of defaultPermissionsForRole(role)) {
        rows.push({ role, permission });
      }
    }
    if (rows.length === 0) return;
    await this.prisma.rolePermission.createMany({ data: rows });
  }

  async getPermissionsForRole(role: AdminRole): Promise<AdminPermission[]> {
    if (role === AdminRole.SUPER_ADMIN) {
      return Object.values(AdminPermission);
    }
    const rows = await this.prisma.rolePermission.findMany({
      where: { role },
      select: { permission: true },
    });
    if (rows.length === 0) {
      return defaultPermissionsForRole(role);
    }
    return rows.map((r) => r.permission);
  }

  async roleHasPermission(
    role: AdminRole,
    permission: AdminPermission,
  ): Promise<boolean> {
    if (role === AdminRole.SUPER_ADMIN) return true;
    const permissions = await this.getPermissionsForRole(role);
    return permissions.includes(permission);
  }

  catalog() {
    return ADMIN_PERMISSION_CATALOG;
  }

  async listRoleMatrix() {
    const roles = [AdminRole.BACK_OFFICE, AdminRole.ADMIN];
    const matrix: Record<string, AdminPermission[]> = {};
    for (const role of roles) {
      matrix[role] = await this.getPermissionsForRole(role);
    }
    return {
      catalog: this.catalog(),
      roles,
      matrix,
    };
  }

  async setRolePermissions(role: AdminRole, permissions: AdminPermission[]) {
    if (role === AdminRole.SUPER_ADMIN) {
      return this.getPermissionsForRole(role);
    }
    const unique = [...new Set(permissions)];
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { role } }),
      this.prisma.rolePermission.createMany({
        data: unique.map((permission) => ({ role, permission })),
      }),
    ]);
    return this.getPermissionsForRole(role);
  }
}
