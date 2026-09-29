import { Module } from '@nestjs/common';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';
import { SavingsWithdrawalsService } from './savings-withdrawals.service';
import { AuthModule } from '../auth/auth.module';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [SavingsController],
  providers: [SavingsService, SavingsWithdrawalsService],
  exports: [SavingsService, SavingsWithdrawalsService],
})
export class SavingsModule {}
