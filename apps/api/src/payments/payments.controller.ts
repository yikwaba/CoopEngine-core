import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const PAYMENTS_READ = ['payments.reconcile', 'savings.post', 'reports.view', 'settings.manage'];

/** Public Monnify webhook endpoint (signature-verified). */
import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

class CreateIntentDto {
  @IsUUID()
  memberId!: string;

  @IsOptional()
  @IsIn(['SAVINGS_DEPOSIT', 'LOAN_REPAYMENT', 'SHARE_PURCHASE'])
  purpose?: 'SAVINGS_DEPOSIT' | 'LOAN_REPAYMENT' | 'SHARE_PURCHASE';

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  expectedAmount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  reference?: string;

  @IsOptional()
  @IsString()
  dueAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

class RecordTransactionDto {
  @IsOptional()
  @IsIn(['MONNIFY', 'MANUAL', 'PAYSTACK'])
  provider?: string;

  @IsString()
  @MaxLength(128)
  providerReference!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  payerName?: string;

  @IsOptional()
  @IsString()
  payerAccount?: string;

  @IsOptional()
  @IsString()
  narration?: string;

  @IsOptional()
  @IsString()
  virtualAccountNo?: string;

  @IsOptional()
  @IsString()
  receivedAt?: string;

  @IsOptional()
  @IsObject()
  raw?: Record<string, unknown>;
}

class AssignExceptionDto {
  @IsUUID()
  memberId!: string;

  @IsOptional()
  @IsIn(['SAVINGS_DEPOSIT', 'LOAN_REPAYMENT', 'SHARE_PURCHASE'])
  purpose?: 'SAVINGS_DEPOSIT' | 'LOAN_REPAYMENT' | 'SHARE_PURCHASE';
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post('monnify/webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Req() req: Request,
    @Body() payload: Record<string, unknown>,
    @Headers('monnify-signature') signature?: string,
  ) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8');
    return this.paymentsService.handleWebhook(payload, rawBody, signature);
  }

  @Get('virtual-accounts')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(...PAYMENTS_READ)
  listVirtualAccounts(@CurrentUser() principal: AuthPrincipal) {
    return this.paymentsService.listVirtualAccounts(principal.organizationId);
  }

  @Post('virtual-accounts')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('payments.reconcile', 'savings.post', 'settings.manage')
  createVirtualAccount(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: { memberId: string },
  ) {
    return this.paymentsService.createVirtualAccount(
      principal.organizationId,
      String(body.memberId ?? ''),
    );
  }

  /* ---------------------------------------------------------------- reconciliation */

  @Post('intents')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('payments.reconcile', 'savings.post')
  createIntent(@CurrentUser() user: AuthPrincipal, @Body() dto: CreateIntentDto) {
    return this.reconciliation.createIntent(user.organizationId, user.userId, dto);
  }

  @Get('intents')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(...PAYMENTS_READ)
  intents(
    @CurrentUser() user: AuthPrincipal,
    @Query('status') status?: string,
    @Query('memberId') memberId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reconciliation.listIntents(user.organizationId, {
      status,
      memberId,
      limit: Number(limit) || undefined,
    });
  }

  @Post('intents/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('payments.reconcile')
  cancelIntent(@CurrentUser() user: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.reconciliation.cancelIntent(user.organizationId, user.userId, id);
  }

  /** Record money that arrived (a bank statement line, or a provider callback). */
  @Post('transactions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('payments.reconcile', 'savings.post')
  recordTransaction(@CurrentUser() user: AuthPrincipal, @Body() dto: RecordTransactionDto) {
    return this.reconciliation.recordTransaction(user.organizationId, user.userId, dto);
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('payments.reconcile')
  sweep(@CurrentUser() user: AuthPrincipal) {
    return this.reconciliation.sweep(user.organizationId, user.userId);
  }

  @Get('exceptions')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(...PAYMENTS_READ)
  exceptions(@CurrentUser() user: AuthPrincipal) {
    return this.reconciliation.listExceptions(user.organizationId);
  }

  @Post('exceptions/:id/assign')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('payments.reconcile', 'savings.post')
  assignException(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignExceptionDto,
  ) {
    return this.reconciliation.assignException(user.organizationId, user.userId, id, dto);
  }

  @Get('reconciliation')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(...PAYMENTS_READ)
  reconciliationSummary(@CurrentUser() user: AuthPrincipal) {
    return this.reconciliation.summary(user.organizationId);
  }
}

@Controller('payments/internal')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PaymentsInternalController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('notifications')
  @RequirePermissions('payments.reconcile', 'audit.view', 'settings.manage')
  async listNotifications(
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query('accountNumber') accountNumber?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const { items, total } = await this.paymentsService.listNotifications(
      principal.organizationId,
      accountNumber,
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
    res.setHeader('X-Total-Count', String(total));
    return items;
  }

}
