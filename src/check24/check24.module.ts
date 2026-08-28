import { Module, forwardRef } from '@nestjs/common';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AutomationModule } from '../automation/automation.module';
import { HostawayModule } from '../hostaway/hostaway.module';
import { LoggingModule } from '../logging/logging.module';
import { Check24AdminController } from './check24-admin.controller';
import { Check24BookingService } from './check24-booking.service';
import { Check24Client } from './check24.client';
import { Check24PropertyMapper } from './check24-property.mapper';
import { Check24SyncScheduler } from './check24-sync.scheduler';
import { Check24SyncSettingsService } from './check24-sync-settings.service';
import { Check24SyncService } from './check24-sync.service';
import { Check24WebhookController } from './check24-webhook.controller';

@Module({
  imports: [HostawayModule, LoggingModule, forwardRef(() => AutomationModule)],
  controllers: [Check24AdminController, Check24WebhookController],
  providers: [
    Check24Client,
    Check24PropertyMapper,
    Check24SyncService,
    Check24SyncSettingsService,
    Check24BookingService,
    Check24SyncScheduler,
    PermissionsGuard,
    RolesGuard,
  ],
  exports: [Check24Client, Check24SyncService, Check24BookingService],
})
export class Check24Module {}
