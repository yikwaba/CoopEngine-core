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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { LoansService } from './loans.service';
import { CreateLoanDto, RejectLoanDto } from './dto/loans.dto';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

class ArrearsMarkDto {
  @IsOptional()
  @IsNumber()
  @Min(31)
  @Max(365)
  daysLate?: number;
}

class RestructureDto {
  @IsNumber()
  @Min(1)
  @Max(60)
  newTermMonths!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(255)
  reason!: string;
}

class GuarantorDto {
  @IsUUID()
  memberId!: string;
}

class RepaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100_000_000_000)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(100)
  idempotencyKey?: string;
}
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
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const { items, total } = await this.loansService.list(
      principal.organizationId,
      status,
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
    res.setHeader('X-Total-Count', String(total));
    return items;
  }

  @Get('arrears')
  @RequirePermissions(...LOAN_READ)
  arrears(@CurrentUser() principal: AuthPrincipal) {
    return this.loansService.arrears(principal.organizationId);
  }

  @Post('arrears/mark')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.review')
  markDefaults(@CurrentUser() principal: AuthPrincipal, @Body() dto: ArrearsMarkDto) {
    return this.loansService.markDefaults(
      principal.organizationId,
      principal.userId,
      dto.daysLate ?? 90,
    );
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

  @Get(':id/payments')
  @RequirePermissions(...LOAN_READ)
  payments(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
  ) {
    return this.loansService.repaymentsHistory(principal.organizationId, loanId);
  }

  @Get(':id/schedule')
  @RequirePermissions(...LOAN_READ)
  schedule(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
  ) {
    return this.loansService.listSchedule(principal.organizationId, loanId);
  }

  @Post(':id/repayments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.review', 'loans.approve', 'savings.post', 'payments.reconcile')
  repay(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
    @Body() dto: RepaymentDto,
  ) {
    return this.loansService.captureRepayment(
      principal.organizationId,
      principal.userId,
      loanId,
      dto.amount,
      dto.description,
      dto.idempotencyKey,
    );
  }

  @Post(':id/restructure')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('loans.restructure')
  restructure(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
    @Body() dto: RestructureDto,
  ) {
    return this.loansService.restructure(
      principal.organizationId,
      principal.userId,
      loanId,
      dto.newTermMonths,
      dto.reason,
    );
  }

  @Post(':id/guarantors')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('loans.review')
  addGuarantor(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
    @Body() dto: GuarantorDto,
  ) {
    return this.loansService.addGuarantor(
      principal.organizationId,
      principal.userId,
      loanId,
      dto.memberId,
    );
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
