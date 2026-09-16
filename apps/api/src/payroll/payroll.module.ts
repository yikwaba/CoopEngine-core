import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [AuthModule, AdminModule, LedgerModule],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
