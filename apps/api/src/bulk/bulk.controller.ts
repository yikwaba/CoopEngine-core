import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { BulkService } from './bulk.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

class ImportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MinLength(1)
  csv!: string;
}

class CommitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  batchId!: string;
}

@Controller('bulk')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BulkController {
  constructor(private readonly bulkService: BulkService) {}

  // ---- share purchases -------------------------------------------------

  @Post('share-purchases/preview')
  @RequirePermissions('shares.post', 'payroll.upload', 'settings.manage')
  sharePreview(@CurrentUser() principal: AuthPrincipal, @Body() dto: ImportDto) {
    return this.bulkService.preview(
      principal.organizationId,
      'SHARE_PURCHASE',
      dto.filename,
      dto.csv,
    );
  }

  @Post('share-purchases/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shares.post', 'payroll.upload', 'settings.manage')
  shareCommit(@CurrentUser() principal: AuthPrincipal, @Body() dto: CommitDto) {
    return this.bulkService.commit(
      principal.organizationId,
      'SHARE_PURCHASE',
      principal.userId,
      dto.batchId,
    );
  }

  // ---- loan repayment collections ---------------------------------------

  @Post('loan-repayments/preview')
  @RequirePermissions('loans.review', 'payroll.upload', 'payments.reconcile', 'settings.manage')
  loanPreview(@CurrentUser() principal: AuthPrincipal, @Body() dto: ImportDto) {
    return this.bulkService.preview(
      principal.organizationId,
      'LOAN_REPAYMENT',
      dto.filename,
      dto.csv,
    );
  }

  @Post('loan-repayments/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.review', 'payroll.upload', 'payments.reconcile', 'settings.manage')
  loanCommit(@CurrentUser() principal: AuthPrincipal, @Body() dto: CommitDto) {
    return this.bulkService.commit(
      principal.organizationId,
      'LOAN_REPAYMENT',
      principal.userId,
      dto.batchId,
    );
  }
}
