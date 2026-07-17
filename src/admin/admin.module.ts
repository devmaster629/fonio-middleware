import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FonioModule } from '../fonio/fonio.module';
import { HostawayModule } from '../hostaway/hostaway.module';
import { RulesModule } from '../rules/rules.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminController } from './admin.controller';
import { AdminUsersController } from './admin-users.controller';
import { RolePermissionsController } from './role-permissions.controller';
import { AdminUsersService } from './admin-users.service';
import { PermissionsService } from './permissions.service';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    FonioModule,
    HostawayModule,
    RulesModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') ?? '8h' },
      }),
    }),
  ],
  controllers: [
    AdminAuthController,
    AdminController,
    AdminUsersController,
    RolePermissionsController,
  ],
  providers: [
    AdminAuthService,
    AdminUsersService,
    PermissionsService,
    JwtStrategy,
    RolesGuard,
    PermissionsGuard,
  ],
  exports: [PermissionsService],
})
export class AdminModule {}
