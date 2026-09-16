import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { ApprovalsService } from './approvals.service';

@Controller('approvals')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /** Everything waiting for a decision, with what this caller can act on. */
  @Get()
  @RequirePermissions(
    'savings.approve',
    'loans.approve',
    'ledger.approve',
    'payroll.approve',
    'payments.reconcile',
  )
  inbox(@CurrentUser() principal: AuthPrincipal) {
    return this.approvals.inbox(
      principal.organizationId,
      principal.permissions,
      principal.userId,
    );
  }

  @Post('payroll/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.approve')
  approvePayroll(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.approvals.approvePayroll(principal.organizationId, principal.userId, id);
  }

  @Post('payroll/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.approve')
  rejectPayroll(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('reason') reason: string,
  ) {
    return this.approvals.rejectPayroll(principal.organizationId, principal.userId, id, reason);
  }

  @Post('journals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ledger.approve')
  approveJournal(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.approvals.approveJournal(principal.organizationId, principal.userId, id);
  }
}
