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
import { SavingsService } from './savings.service';
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

@Controller('savings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SavingsController {
  constructor(private readonly savingsService: SavingsService) {}

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
  withdraw(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) accountId: string,
    @Body() dto: MoneyOpDto,
  ) {
    return this.savingsService.withdraw(
      principal.organizationId,
      principal.userId,
      accountId,
      dto.amount,
      dto.description,
      dto.idempotencyKey,
    );
  }
}
