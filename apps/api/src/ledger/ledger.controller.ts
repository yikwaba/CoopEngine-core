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
import { LedgerService } from './ledger.service';
import { CreateJournalDto, PeriodQueryDto } from './dto/ledger.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { IsString, MaxLength, MinLength } from 'class-validator';

const READ_PERMISSIONS = [
  'journals.create',
  'journals.approve',
  'journals.post',
  'reports.view',
  'settings.manage',
];

class ReverseDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason!: string;
}

@Controller('ledger')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get('accounts')
  @RequirePermissions(...READ_PERMISSIONS)
  accounts(@CurrentUser() principal: AuthPrincipal) {
    return this.ledgerService.listAccounts(principal.organizationId);
  }

  @Get('periods')
  @RequirePermissions(...READ_PERMISSIONS)
  periods(@CurrentUser() principal: AuthPrincipal) {
    return this.ledgerService.listPeriods(principal.organizationId);
  }

  @Get('journals')
  @RequirePermissions(...READ_PERMISSIONS)
  async journals(
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const { items, total } = await this.ledgerService.listJournals(
      principal.organizationId,
      status,
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
    res.setHeader('X-Total-Count', String(total));
    return items;
  }

  @Get('journals/:id')
  @RequirePermissions(...READ_PERMISSIONS)
  journal(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) journalId: string,
  ) {
    return this.ledgerService.getJournal(principal.organizationId, journalId);
  }

  @Get('trial-balance')
  @RequirePermissions('reports.view', 'journals.approve', 'journals.post', 'journals.create')
  trialBalance(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: PeriodQueryDto,
  ) {
    return this.ledgerService.trialBalance(
      principal.organizationId,
      query.period,
    );
  }

  // ------------------------------------------------------------- write side

  @Post('journals')
  @RequirePermissions('journals.create')
  createJournal(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateJournalDto,
  ) {
    return this.ledgerService.createDraft(
      principal.organizationId,
      principal.userId,
      dto,
    );
  }

  @Post('journals/:id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('journals.create')
  submit(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) journalId: string,
  ) {
    return this.ledgerService.submit(
      principal.organizationId,
      principal.userId,
      journalId,
    );
  }

  @Post('journals/:id/approve-post')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('journals.approve')
  approvePost(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) journalId: string,
  ) {
    return this.ledgerService.approveAndPost(
      principal.organizationId,
      principal.userId,
      journalId,
    );
  }

  @Post('journals/:id/reverse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('journals.approve')
  reverse(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) journalId: string,
    @Body() dto: ReverseDto,
  ) {
    return this.ledgerService.reverse(
      principal.organizationId,
      principal.userId,
      journalId,
      dto.reason,
    );
  }
}
