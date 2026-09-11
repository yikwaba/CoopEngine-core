import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { SavingsService } from './savings.service';
import { SavingsWithdrawalsService } from './savings-withdrawals.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const SAVINGS_READ = [
  'savings.post',
  'savings.withdraw',
  'reports.view',
  'settings.manage',
];

class OpenAccountDto {
  @IsOptional()
  @IsUUID()
  productId?: string;
}

class MoneyOpDto {
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

class StatementQueryDto {
  @IsOptional()
  limit?: number;
}

export class WithdrawalPolicyDto {
  /** null disables approvals; 0 requires approval for every withdrawal; N for amounts above N. */
  @ValidateIf((o: { threshold?: number | null }) => o.threshold !== null)
  @IsNumber()
  @Min(0)
  threshold!: number | null;
}

export class RejectWithdrawalDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

@Controller('savings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SavingsController {
  constructor(private readonly savingsService: SavingsService, private readonly withdrawals: SavingsWithdrawalsService) {}

  @Get('products')
  @RequirePermissions(...SAVINGS_READ)
  products(@CurrentUser() principal: AuthPrincipal) {
    return this.savingsService.listProducts(principal.organizationId);
  }

  @Post('member/:memberId/account')
  @RequirePermissions('savings.post')
  openAccount(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: OpenAccountDto,
  ) {
    return this.savingsService.openAccount(
      principal.organizationId,
      memberId,
      dto.productId,
    );
  }

  @Get('member/:memberId/accounts')
  @RequirePermissions(...SAVINGS_READ)
  memberAccounts(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ) {
    return this.savingsService.listMemberAccounts(
      principal.organizationId,
      memberId,
    );
  }

  @Get('interest/preview')
  @RequirePermissions('savings.post', 'savings.withdraw', 'reports.view', 'settings.manage')
  interestPreview(
    @CurrentUser() principal: AuthPrincipal,
    @Query('period') period?: string,
  ) {
    return this.savingsService.interestPreview(principal.organizationId, period);
  }

  @Post('interest/post')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('savings.post')
  postInterest(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: { period?: string },
  ) {
    return this.savingsService.postInterest(
      principal.organizationId,
      principal.userId,
      body.period,
    );
  }

  @Get('accounts/:id')
  @RequirePermissions(...SAVINGS_READ)
  account(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) accountId: string,
  ) {
    return this.savingsService.getAccount(principal.organizationId, accountId);
  }

  @Get('accounts/:id/statement')
  @RequirePermissions(...SAVINGS_READ)
  statement(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) accountId: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.savingsService.statement(
      principal.organizationId,
      accountId,
      query.limit,
    );
  }

  @Post('accounts/:id/deposits')
  @RequirePermissions('savings.post')
  deposit(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) accountId: string,
    @Body() dto: MoneyOpDto,
  ) {
    return this.savingsService.deposit(
      principal.organizationId,
      principal.userId,
      accountId,
      dto.amount,
      dto.description,
      dto.idempotencyKey,
    );
  }

  @Post('accounts/:id/withdrawals')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('savings.withdraw')
  async withdraw(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) accountId: string,
    @Body() dto: MoneyOpDto,
  ) {
    const decision = await this.withdrawals.request(
      principal.organizationId,
      principal.userId,
      'STAFF',
      null,
      accountId,
      dto.amount,
      dto.description,
    );
    // Backwards compatible: a posted withdrawal returns the account row itself
    // (plus kind), while a parked one returns the pending request.
    return decision.kind === 'POSTED'
      ? { ...decision.account, kind: 'POSTED' as const }
      : { kind: 'PENDING' as const, requestId: decision.requestId, status: decision.status };
  }

  // ------------------------------------------------- withdrawal approvals
  @Get('withdrawals')
  @RequirePermissions('savings.withdraw', 'savings.approve')
  listWithdrawalRequests(
    @CurrentUser() principal: AuthPrincipal,
    @Query('status') status?: string,
    @Query('memberId') memberId?: string,
  ) {
    return this.withdrawals.list(principal.organizationId, status, memberId);
  }

  @Get('settings/withdrawal-approval')
  @RequirePermissions('savings.withdraw', 'settings.manage')
  withdrawalPolicy(@CurrentUser() principal: AuthPrincipal) {
    return this.withdrawals.policy(principal.organizationId);
  }

  @Patch('settings/withdrawal-approval')
  @RequirePermissions('savings.approve', 'settings.manage')
  setWithdrawalPolicy(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: WithdrawalPolicyDto,
  ) {
    return this.withdrawals.setThreshold(
      principal.organizationId,
      principal.userId,
      dto.threshold,
    );
  }

  @Post('withdrawals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('savings.approve', 'settings.manage')
  approveWithdrawal(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.withdrawals.approve(principal.organizationId, principal.userId, id);
  }

  @Post('withdrawals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('savings.approve', 'settings.manage')
  rejectWithdrawal(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectWithdrawalDto,
  ) {
    return this.withdrawals.reject(principal.organizationId, principal.userId, id, dto.notes);
  }
}
