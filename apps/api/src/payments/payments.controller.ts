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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const PAYMENTS_READ = ['payments.reconcile', 'savings.post', 'reports.view', 'settings.manage'];

/** Public Monnify webhook endpoint (signature-verified). */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

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
