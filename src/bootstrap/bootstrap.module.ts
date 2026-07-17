import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { RulesModule } from '../rules/rules.module';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [RulesModule, AdminModule],
  providers: [BootstrapService],
})
export class BootstrapModule {}
