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
import { IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApprovalsService } from './approvals.service';

const APPROVAL_KINDS = ['WITHDRAWAL', 'PAYROLL', 'LOAN', 'JOURNAL', 'EXPENSE'] as const;

class CreateApprovalRequestDto {
  @IsIn(APPROVAL_KINDS)
  kind!: (typeof APPROVAL_KINDS)[number];

  @IsString()
  @MaxLength(32)
  entityType!: string;

  @IsUUID()
  entityId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

class DecideApprovalRequestDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

@Controller('approvals')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /**
   * Raise a policy-backed request. The owning money-path services call the same
   * service directly; this route exists for audited/manual approval workflows.
   */
  @Post('requests')
  @RequirePermissions('savings.withdraw', 'payroll.upload', 'loans.review', 'journals.create')
  createRequest(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateApprovalRequestDto,
  ) {
    return this.approvals.createRequest(principal.organizationId, principal.userId, dto);
  }

  @Post('requests/:id/decisions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('savings.approve', 'payroll.approve', 'loans.approve', 'ledger.approve')
  decideRequest(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecideApprovalRequestDto,
  ) {
    return this.approvals.decideRequest(principal.organizationId, principal.userId, id, dto);
  }

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
