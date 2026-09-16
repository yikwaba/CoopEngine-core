import { Module } from '@nestjs/common';
import { PaymentsController, PaymentsInternalController } from './payments.controller';
import { SavingsModule } from '../savings/savings.module';
import { LoansModule } from '../loans/loans.module';
import { SharesModule } from '../shares/shares.module';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SharesModule, LoansModule, SavingsModule, AuthModule],
  controllers: [PaymentsController, PaymentsInternalController],
  providers: [PaymentsService, ReconciliationService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
