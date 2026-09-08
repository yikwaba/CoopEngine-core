import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MembersModule } from './members/members.module';
import { LedgerModule } from './ledger/ledger.module';
import { SavingsModule } from './savings/savings.module';
import { LoansModule } from './loans/loans.module';
import { SharesModule } from './shares/shares.module';
import { ReportsModule } from './reports/reports.module';
import { PayrollModule } from './payroll/payroll.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    OrganizationsModule,
    MembersModule,
    LedgerModule,
    SavingsModule,
    LoansModule,
    SharesModule,
    ReportsModule,
    PayrollModule,
    HealthModule,
  ],
})
export class AppModule {}
