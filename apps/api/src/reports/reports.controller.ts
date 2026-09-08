import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const REPORT_READ = ['reports.view', 'audit.view', 'settings.manage'];

class AuditQueryDto {
  @IsOptional()
  limit?: number;

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

  @Get('audit-logs')
  @RequirePermissions('audit.view', 'settings.manage', 'reports.view')
  auditLogs(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: AuditQueryDto,
  ) {
    return this.reportsService.auditLogs(
      principal.organizationId,
      query.limit,
      query.action,
    );
  }
}
