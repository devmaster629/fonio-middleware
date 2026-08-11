import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Check24Client } from './check24.client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminPermission } from '@prisma/client';
import { Permissions } from '../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Check24BookingService } from './check24-booking.service';
import { Check24SyncSettingsService } from './check24-sync-settings.service';
import { Check24SyncService } from './check24-sync.service';
import { UpdateCheck24SyncSettingsDto } from './dto/check24-sync-settings.dto';

@ApiTags('admin-check24')
@ApiBearerAuth()
@Controller('api/v1/admin/check24')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class Check24AdminController {
  constructor(
    private readonly sync: Check24SyncService,
    private readonly bookings: Check24BookingService,
    private readonly check24: Check24Client,
    private readonly syncSettings: Check24SyncSettingsService,
  ) {}

  @Get('status')
  @Permissions(AdminPermission.DASHBOARD_VIEW)
  @ApiOperation({ summary: 'CHECK24 integration status + ping' })
  async status() {
    const [status, settings] = await Promise.all([
      this.sync.status(),
      this.syncSettings.getOrCreate(),
    ]);
    return { ...status, settings };
  }

  @Get('sync/settings')
  @Permissions(AdminPermission.DASHBOARD_VIEW)
  @ApiOperation({ summary: 'CHECK24 auto-sync settings' })
  getSyncSettings() {
    return this.syncSettings.getOrCreate();
  }

  @Patch('sync/settings')
  @Permissions(AdminPermission.SYNC_SETTINGS_EDIT)
  @ApiOperation({ summary: 'Update CHECK24 auto-sync settings' })
  updateSyncSettings(@Body() dto: UpdateCheck24SyncSettingsDto) {
    return this.syncSettings.update(dto);
  }

  @Get('mappings')
  @Permissions(AdminPermission.LISTINGS_VIEW)
  @ApiOperation({ summary: 'List Hostaway ↔ CHECK24 property mappings' })
  listMappings() {
    return this.sync.listMappings();
  }

  @Patch('mappings/:id')
  @Permissions(AdminPermission.LISTINGS_EDIT)
  @ApiOperation({ summary: 'Enable/disable a CHECK24 mapping' })
  setEnabled(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    return this.sync.setMappingEnabled(id, Boolean(body.enabled));
  }

  @Get('preview/:hostawayId')
  @Permissions(AdminPermission.LISTINGS_VIEW)
  @ApiOperation({ summary: 'Preview CHECK24 property payload for a Hostaway listing' })
  preview(@Param('hostawayId') hostawayId: string) {
    return this.sync.previewProperty(Number(hostawayId));
  }

  @Post('sync')
  @Permissions(AdminPermission.SYNC_RUN)
  @ApiOperation({
    summary: 'Push content / availability / rates to CHECK24 (background)',
  })
  triggerSync(
    @Body()
    body?: {
      content?: boolean;
      availability?: boolean;
      rates?: boolean;
      listingIds?: number[];
    },
  ) {
    if (this.sync.isSyncInProgress()) {
      return { started: false, message: 'CHECK24 sync already running' };
    }
    void this.sync.syncAll(body).catch((error) => {
      console.error(
        `CHECK24 background sync failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    });
    return { started: true, message: 'CHECK24 sync started in background' };
  }

  @Post('sync/:hostawayId/content')
  @Permissions(AdminPermission.SYNC_RUN)
  @ApiOperation({ summary: 'Push one listing content to CHECK24' })
  async syncOneContent(@Param('hostawayId') hostawayId: string) {
    const listingId = await this.sync.findListingIdByHostawayId(
      Number(hostawayId),
    );
    if (!listingId) {
      return { ok: false, message: 'Listing not found locally' };
    }
    try {
      const propertyId = await this.sync.syncListingContent(listingId);
      return { ok: true, propertyId };
    } catch (err) {
      throw new BadRequestException(this.check24.describeError(err));
    }
  }

  @Post('webhooks/bookings/register')
  @Permissions(AdminPermission.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Register CHECK24 booking webhook pointing at this app' })
  registerWebhook(@Body() body?: { url?: string }) {
    return this.bookings.registerWebhook(body?.url);
  }

  @Post('bookings/poll')
  @Permissions(AdminPermission.SYNC_RUN)
  @ApiOperation({ summary: 'Poll CHECK24 bookings and import into Hostaway' })
  pollBookings() {
    return this.bookings.pollRecentBookings();
  }

  @Get('bookings')
  @Permissions(AdminPermission.RESERVATIONS_VIEW)
  @ApiOperation({ summary: 'List locally tracked CHECK24 bookings' })
  listBookings(@Query('limit') limit?: string) {
    return this.bookings.listLocalBookings(limit ? Number(limit) : 50);
  }
}
