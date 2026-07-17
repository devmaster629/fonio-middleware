import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission, AdminRole } from '@prisma/client';
import { Request } from 'express';
import { Permissions } from '../common/decorators/permissions.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AdminAuditInterceptor } from '../logging/admin-audit.interceptor';
import { AdminUsersService } from './admin-users.service';
import { CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-users.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/users')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@UseInterceptors(AdminAuditInterceptor)
@Roles(AdminRole.SUPER_ADMIN)
@Permissions(AdminPermission.USERS_MANAGE)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'List admin users (super admin only)' })
  list() {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create admin user (super admin only)' })
  create(@Body() dto: CreateAdminUserDto) {
    return this.users.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update admin user (super admin only)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.users.update(id, dto, req.user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate admin user (super admin only)' })
  remove(@Param('id') id: string, @Req() req: Request & { user: { id: string } }) {
    return this.users.remove(id, req.user.id);
  }
}
