import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  Get,
  Query,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { PayrollService } from './payroll.service';
import { PlanLimitsService } from '../admin/plan-limits.service';
import { PreviewImportDto } from '../members/dto/import-member.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

class CommitBatchDto {
  @IsUUID()
  batchId!: string;
}

@Controller('payroll')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PayrollController {
  constructor(private readonly payrollService: PayrollService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  @Post('import/preview')
  @RequirePermissions('payroll.upload')
  preview(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: PreviewImportDto,
  ) {
    return this.payrollService.preview(
      principal.organizationId,
      principal.userId,
      dto,
    );
  }

  /**
   * Commit now means *submit for approval*. Money leaving many members' savings at once should not
   * post on one person's say-so, so posting moved behind /batches/:id/approve.
   */
  @Post('import/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.upload', 'payroll.post')
  async commit(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CommitBatchDto,
  ) {
    await this.planLimits.assertFeature(principal.organizationId, 'payroll');
    return this.payrollService.submit(
      principal.organizationId,
      principal.userId,
      dto.batchId,
    );
  }

  @Get('batches')
  @RequirePermissions('payroll.upload', 'payroll.post', 'payroll.approve')
  batches(
    @CurrentUser() principal: AuthPrincipal,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.payrollService.listBatches(principal.organizationId, {
      status,
      limit: Number(limit) || undefined,
    });
  }

  @Get('batches/:id')
  @RequirePermissions('payroll.upload', 'payroll.post', 'payroll.approve')
  batch(@CurrentUser() principal: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payrollService.batchDetail(principal.organizationId, id);
  }

  /** Approve and post, atomically. A different user from the submitter must do it. */
  @Post('batches/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.approve')
  async approve(@CurrentUser() principal: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.planLimits.assertFeature(principal.organizationId, 'payroll');
    return this.payrollService.approve(principal.organizationId, principal.userId, id);
  }

  @Post('batches/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.approve')
  reject(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('reason') reason: string,
  ) {
    return this.payrollService.reject(principal.organizationId, principal.userId, id, reason);
  }

  /** Reverse a posted batch: every entry it created is reversed through the ledger. */
  @Post('batches/:id/reverse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.post')
  reverse(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('reason') reason: string,
  ) {
    return this.payrollService.reverse(principal.organizationId, principal.userId, id, reason);
  }
}
