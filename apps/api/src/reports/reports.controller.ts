import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const REPORT_READ = ['reports.view', 'audit.view', 'settings.manage'];

class AuditQueryDto {
  @IsOptional()
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsNumber()
  offset?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  action?: string;
}

@Controller('reports')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('member/:memberId/360')
  @RequirePermissions(...REPORT_READ)
  member360(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ) {
    return this.reportsService.member360(principal.organizationId, memberId);
  }

  @Get('savings-book')
  @RequirePermissions(...REPORT_READ)
  savingsBook(@CurrentUser() principal: AuthPrincipal) {
    return this.reportsService.savingsBook(principal.organizationId);
  }

  @Get('loan-book')
  @RequirePermissions(...REPORT_READ)
  loanBook(@CurrentUser() principal: AuthPrincipal) {
    return this.reportsService.loanBook(principal.organizationId);
  }

  @Get('savings-reconciliation')
  @RequirePermissions('reports.view', 'settings.manage', 'savings.post', 'payroll.post')
  savingsReconciliation(@CurrentUser() principal: AuthPrincipal) {
    return this.reportsService.savingsReconciliation(principal.organizationId);
  }

  @Get('contribution-schedule')
  @RequirePermissions('reports.view', 'reports.export', 'settings.manage')
  contributionSchedule(
    @CurrentUser() principal: AuthPrincipal,
    @Query('months') months?: string,
  ) {
    return this.reportsService.contributionSchedule(
      principal.organizationId,
      months ? Number(months) : undefined,
    );
  }

  @Get('loans-aging')
  @RequirePermissions('reports.view', 'reports.export', 'loans.approve')
  loansAging(@CurrentUser() principal: AuthPrincipal) {
    return this.reportsService.loansAging(principal.organizationId);
  }

  @Get('exited-members')
  @RequirePermissions('reports.view', 'reports.export', 'settings.manage')
  exitedMembers(@CurrentUser() principal: AuthPrincipal) {
    return this.reportsService.exitedMembers(principal.organizationId);
  }

  @Get('savings-interest-preview')
  @RequirePermissions('reports.view', 'reports.export', 'settings.manage')
  savingsInterestPreview(@CurrentUser() principal: AuthPrincipal) {
    return this.reportsService.savingsInterestPreview(principal.organizationId);
  }

  @Get('audit-logs')
  @RequirePermissions('audit.view', 'settings.manage', 'reports.view')
  async auditLogs(
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query() query: AuditQueryDto,
  ) {
    const { items, total } = await this.reportsService.auditLogs(
      principal.organizationId,
      query.limit,
      query.action,
      query.offset,
    );
    res.setHeader('X-Total-Count', String(total));
    return items;
  }
}
