import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { NotificationsService } from './notifications.service';

class DispatchDto {
  @IsOptional()
  @IsIn(['IN_APP', 'SMS', 'EMAIL'])
  onlyChannel?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(500)
  limit?: number;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @RequirePermissions('notifications.view', 'settings.manage')
  async list(
    @CurrentUser() user: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.notificationsService.list(user.organizationId, {
      status,
      channel,
      type,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    res.setHeader('X-Total-Count', String(result.total));
    res.setHeader('X-Pending-Count', String(result.pending));
    return result;
  }

  @Post('dispatch')
  @RequirePermissions('notifications.manage', 'settings.manage')
  dispatch(@CurrentUser() user: AuthPrincipal, @Body() dto: DispatchDto) {
    return this.notificationsService.dispatchPending(user.organizationId, user.userId, {
      onlyChannel: dto.onlyChannel,
      limit: dto.limit,
    });
  }
}
