import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { GlobalHttpExceptionFilter } from './common/filters/http-exception.filter';
import { AdminModule } from './admin/admin.module';
import { AutomationModule } from './automation/automation.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { FonioModule } from './fonio/fonio.module';
import { HealthController } from './health.controller';
import { HostawayModule } from './hostaway/hostaway.module';
import { LoggingModule } from './logging/logging.module';
import { PrismaModule } from './prisma/prisma.module';
import { RulesModule } from './rules/rules.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { Check24Module } from './check24/check24.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    LoggingModule,
    HostawayModule,
    RulesModule,
    FonioModule,
    AutomationModule,
    AdminModule,
    WebhooksModule,
    Check24Module,
    BootstrapModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
  ],
})
export class AppModule {}
