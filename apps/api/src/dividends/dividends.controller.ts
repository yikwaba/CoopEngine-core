import { ApiProperty } from '@nestjs/swagger';
import { MAX_NUMERIC_MONEY_INPUT } from '../common/money';
import { SensitiveAction } from '../auth/sensitive-action';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsNumber, IsDefined, MinLength, MaxLength, Max, IsString, Matches, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { DividendsService } from './dividends.service';
import { PlanLimitsService } from '../admin/plan-limits.service';

export class DividendPostDto {
  @ApiProperty({required:true,minLength:4,maxLength:4,pattern:'^\\d{4}$',example:'2026'})
  @IsDefined()
  @MinLength(4)
  @MaxLength(4)
  @IsString()
  @Matches(/^\d{4}$/)
  periodLabel!: string;

  @ApiProperty({minimum:0.01,maximum:MAX_NUMERIC_MONEY_INPUT})
  @Max(MAX_NUMERIC_MONEY_INPUT)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  distributableAmount!: number;
}

@Controller('dividends')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DividendsController {
  constructor(private readonly dividendsService: DividendsService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  @Get('preview')
  @RequirePermissions('dividends.view', 'reports.view')
  preview(
    @CurrentUser() user: AuthPrincipal,
    @Query('period') period: string | undefined,
    @Query('amount') amount: string | undefined,
  ) {
    return this.dividendsService.preview(user.organizationId, period, Number(amount ?? 0));
  }

  @Post('post')
  @RequirePermissions('dividends.post')
  @SensitiveAction('dividends.post')
  async post(@CurrentUser() user: AuthPrincipal, @Body() dto: DividendPostDto) {
    await this.planLimits.assertFeature(user.organizationId, 'dividends');
    return this.dividendsService.post(
      user.organizationId,
      user.userId,
      dto.periodLabel,
      dto.distributableAmount,
    );
  }

  @Get()
  @RequirePermissions('dividends.view', 'reports.view')
  list(@CurrentUser() user: AuthPrincipal) {
    return this.dividendsService.list(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions('dividends.view', 'reports.view')
  getRun(@CurrentUser() user: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.dividendsService.getRun(user.organizationId, id);
  }
}
