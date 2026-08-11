import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class Check24SyncSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getOrCreate() {
    const existing = await this.prisma.check24SyncSettings.findUnique({
      where: { id: 'default' },
    });
    if (existing) return existing;

    const envEnabled =
      (this.config.get('CHECK24_AUTO_SYNC') ?? 'false').toLowerCase() ===
      'true';
    const envContent =
      (this.config.get('CHECK24_AUTO_SYNC_CONTENT') ?? 'false').toLowerCase() ===
      'true';
    const envInterval = Number(
      this.config.get('CHECK24_SYNC_INTERVAL_MINUTES') ?? 30,
    );

    return this.prisma.check24SyncSettings.create({
      data: {
        id: 'default',
        autoSyncEnabled: envEnabled,
        autoSyncContent: envContent,
        intervalMinutes: Number.isFinite(envInterval) ? envInterval : 30,
      },
    });
  }

  async update(data: {
    autoSyncEnabled?: boolean;
    autoSyncContent?: boolean;
    intervalMinutes?: number;
  }) {
    await this.getOrCreate();
    return this.prisma.check24SyncSettings.update({
      where: { id: 'default' },
      data,
    });
  }

  async markAutoSyncCompleted() {
    await this.getOrCreate();
    return this.prisma.check24SyncSettings.update({
      where: { id: 'default' },
      data: { lastAutoSyncAt: new Date() },
    });
  }
}
