import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, AdminRole } from '@prisma/client';
import { Permissions } from '../common/decorators/permissions.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminAuditInterceptor } from '../logging/admin-audit.interceptor';
import { UpdateRolePermissionsDto } from './dto/role-permissions.dto';
import { PermissionsService } from './permissions.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/role-permissions')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@UseInterceptors(AdminAuditInterceptor)
export class RolePermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  @Roles(AdminRole.SUPER_ADMIN)
  @Permissions(AdminPermission.ROLE_PERMISSIONS_MANAGE)
  @ApiOperation({ summary: 'Role permission matrix (super admin)' })
  list() {
    return this.permissions.listRoleMatrix();
  }

  @Put()
  @Roles(AdminRole.SUPER_ADMIN)
  @Permissions(AdminPermission.ROLE_PERMISSIONS_MANAGE)
  @ApiOperation({ summary: 'Update permissions for one role (super admin)' })
  update(@Body() dto: UpdateRolePermissionsDto) {
    return this.permissions.setRolePermissions(dto.role, dto.permissions);
  }
}
