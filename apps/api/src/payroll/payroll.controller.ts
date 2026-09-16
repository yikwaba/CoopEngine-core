import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
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

@Controller('payroll/import')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PayrollController {
  constructor(private readonly payrollService: PayrollService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  @Post('preview')
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

  @Post('commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payroll.post')
  async commit(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CommitBatchDto,
  ) {
    await this.planLimits.assertFeature(principal.organizationId, 'payroll');
    return this.payrollService.commit(
      principal.organizationId,
      principal.userId,
      dto.batchId,
    );
  }
}
