import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LoansService } from './loans.service';
import { CreateLoanDto, RejectLoanDto } from './dto/loans.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const LOAN_READ = [
  'loans.review',
  'loans.approve',
  'loans.disburse',
  'reports.view',
  'settings.manage',
];

@Controller('loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Get('products')
  @RequirePermissions(...LOAN_READ)
  products(@CurrentUser() principal: AuthPrincipal) {
    return this.loansService.listProducts(principal.organizationId);
  }

  @Post()
  @RequirePermissions('loans.review')
  apply(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateLoanDto,
  ) {
    return this.loansService.apply(
      principal.organizationId,
      principal.userId,
      dto,
    );
  }

  @Get()
  @RequirePermissions(...LOAN_READ)
  list(
    @CurrentUser() principal: AuthPrincipal,
    @Query('status') status?: string,
  ) {
    return this.loansService.list(principal.organizationId, status);
  }

  @Get(':id')
  @RequirePermissions(...LOAN_READ)
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
  ) {
    return this.loansService.getLoan(principal.organizationId, loanId);
  }

  @Get(':id/guarantors')
  @RequirePermissions(...LOAN_READ)
  guarantors(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
  ) {
    return this.loansService.listGuarantors(principal.organizationId, loanId);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.approve')
  approve(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
  ) {
    return this.loansService.transition(
      principal.organizationId,
      principal.userId,
      loanId,
      'APPROVED',
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.approve')
  reject(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
    @Body() dto: RejectLoanDto,
  ) {
    return this.loansService.transition(
      principal.organizationId,
      principal.userId,
      loanId,
      'REJECTED',
      dto.reason,
    );
  }

  @Post(':id/disburse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.disburse')
  disburse(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
  ) {
    return this.loansService.transition(
      principal.organizationId,
      principal.userId,
      loanId,
      'DISBURSED',
    );
  }
}
