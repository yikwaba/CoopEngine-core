import { Module } from '@nestjs/common';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';
import { SavingsWithdrawalsService } from './savings-withdrawals.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SavingsController],
  providers: [SavingsService, SavingsWithdrawalsService],
  exports: [SavingsService, SavingsWithdrawalsService],
})
export class SavingsModule {}
