import { Module } from '@nestjs/common';
import { SettingsModule } from './settings/settings.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MembersModule } from './members/members.module';
import { LedgerModule } from './ledger/ledger.module';
import { SavingsModule } from './savings/savings.module';
import { LoansModule } from './loans/loans.module';
import { SharesModule } from './shares/shares.module';
import { PdfModule } from './pdf/pdf.module';
import { ReportsModule } from './reports/reports.module';
import { PayrollModule } from './payroll/payroll.module';
import { MemberAuthModule } from './member-auth/member-auth.module';
import { MemberSpaceModule } from './member-space/member-space.module';
import { OrgUsersModule } from './org-users/org-users.module';
import { PaymentsModule } from './payments/payments.module';
import { BulkModule } from './bulk/bulk.module';
import { ProductsModule } from './products/products.module';
import { DividendsModule } from './dividends/dividends.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DocumentsModule } from './documents/documents.module';
import { BranchesModule } from './branches/branches.module';
import { GoalsModule } from './goals/goals.module';
import { MigrationsModule } from './migrations/migrations.module';
import { DatabaseModule } from './database/database.module';
import { ApprovalsModule } from './approvals/approvals.module';

@Module({
  imports: [
    SettingsModule,
    AdminModule,
    DatabaseModule,
    AuthModule,
    OrganizationsModule,
    MembersModule,
    LedgerModule,
    SavingsModule,
    LoansModule,
    SharesModule,
    ReportsModule,
    PdfModule,
    PayrollModule,
    MemberAuthModule,
    MemberSpaceModule,
    OrgUsersModule,
    PaymentsModule,
    BulkModule,
    ProductsModule,
    DividendsModule,
    NotificationsModule,
    DocumentsModule,
    BranchesModule,
    GoalsModule,
    MigrationsModule,
    HealthModule,
    ApprovalsModule,
  ],
})
export class AppModule {}
