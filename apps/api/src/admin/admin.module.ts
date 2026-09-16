import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminService } from './admin.service';
import { OverviewController } from './overview.controller';
import { PlanLimitsService } from './plan-limits.service';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { TenantsController } from './tenants.controller';

/**
 * SaaS administration: the cooperatives on the platform, their plans, and what a plan entitles
 * them to. Exported so tenant modules can enforce their cooperative's limits and features.
 */
@Module({
  imports: [AuthModule],
  controllers: [OverviewController, TenantsController, PlansController],
  providers: [AdminService, PlansService, PlanLimitsService],
  exports: [PlanLimitsService, PlansService],
})
export class AdminModule {}
