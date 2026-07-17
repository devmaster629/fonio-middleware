import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AdminRole } from '@prisma/client';
import { PermissionsService } from '../admin/permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { RulesService } from '../rules/rules.service';
import { normalizeVerificationConfigFields } from '../fonio/verification-fields';

@Injectable()
export class BootstrapService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly rules: RulesService,
    private readonly permissions: PermissionsService,
  ) {}

  async onModuleInit() {
    await this.seedAdmin();
    await this.permissions.seedDefaultsIfEmpty();
    await this.seedVerificationConfig();
    await this.rules.seedDefaults();
  }

  private async seedAdmin() {
    const email = this.config.get<string>('ADMIN_EMAIL');
    const password = this.config.get<string>('ADMIN_PASSWORD');
    if (!email || !password) return;

    const existing = await this.prisma.adminUser.findUnique({
      where: { email },
    });
    if (existing) {
      if (existing.role !== AdminRole.SUPER_ADMIN) {
        await this.prisma.adminUser.update({
          where: { email },
          data: { role: AdminRole.SUPER_ADMIN },
        });
      }
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.adminUser.create({
      data: {
        email,
        passwordHash,
        role: AdminRole.SUPER_ADMIN,
      },
    });
  }

  private async seedVerificationConfig() {
    const existing = await this.prisma.verificationConfig.findFirst({
      where: { isDefault: true },
    });

    if (!existing) {
      await this.prisma.verificationConfig.create({
        data: {
          name: 'default',
          requiredFields: [
            'stayDates',
            'listingName',
            'phone',
            'email',
            'reservationId',
          ],
          minMatchCount: 3,
          bookingOfferEnabled:
            this.config.get('BOOKING_OFFER_ENABLED') !== 'false',
          isDefault: true,
        },
      });
      return;
    }

    const hasLegacyDates = existing.requiredFields.some(
      (f) => f === 'arrivalDate' || f === 'departureDate',
    );
    const normalized = normalizeVerificationConfigFields(existing.requiredFields);
    const fieldsChanged =
      hasLegacyDates ||
      JSON.stringify(normalized) !== JSON.stringify(existing.requiredFields);

    if (fieldsChanged || (existing.minMatchCount ?? 0) < 1) {
      await this.prisma.verificationConfig.update({
        where: { id: existing.id },
        data: {
          requiredFields: normalized,
          minMatchCount: existing.minMatchCount > 0 ? existing.minMatchCount : 3,
        },
      });
    }
  }
}
