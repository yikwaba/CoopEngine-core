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
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { SharesService } from './shares.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

class PurchaseDto {
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

const SHARES_READ = ['shares.post', 'reports.view', 'settings.manage'];

@Controller('shares')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SharesController {
  constructor(private readonly sharesService: SharesService) {}

  @Get('member/:memberId')
  @RequirePermissions(...SHARES_READ)
  account(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
  ) {
    return this.sharesService.getAccount(principal.organizationId, memberId);
  }

  @Post('member/:memberId/purchases')
  @RequirePermissions('shares.post')
  purchase(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: PurchaseDto,
  ) {
    return this.sharesService.purchase(
      principal.organizationId,
      principal.userId,
      memberId,
      dto.amount,
      dto.description,
      dto.idempotencyKey,
    );
  }

  @Post('member/:memberId/redemptions')
  @RequirePermissions('shares.post')
  redeem(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: PurchaseDto,
  ) {
    return this.sharesService.redeem(
      principal.organizationId,
      principal.userId,
      memberId,
      dto.amount,
      dto.description,
      dto.idempotencyKey,
    );
  }

  @Get('member/:memberId/statement')
  @RequirePermissions(...SHARES_READ)
  statement(
    @CurrentUser() principal: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Query('limit') limit?: string,
  ) {
    return this.sharesService.statement(
      principal.organizationId,
      memberId,
      limit ? Number(limit) : undefined,
    );
  }
}
