import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthPrincipal } from '../common/auth.types';
import { NotificationTemplatesService } from './templates.service';

class UpsertTemplateDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(1000)
  body!: string;

  @IsOptional()
  @IsIn(['SMS', 'EMAIL', 'ANY'])
  channel?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class PreviewTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string;

  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;
}

@Controller('notifications/templates')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  /** Wording belongs to a cooperative, so an org context is required. */
  private orgId(principal: AuthPrincipal): string {
    if (!principal.organizationId) {
      throw new BadRequestException(
        'Notification wording is per cooperative — select an organisation first.',
      );
    }
    return principal.organizationId;
  }

  @Get()
  @RequirePermissions('notifications.view')
  list(@CurrentUser() principal: AuthPrincipal) {
    return this.templates.list(this.orgId(principal));
  }

  @Put(':code')
  @RequirePermissions('notifications.manage')
  upsert(
    @CurrentUser() principal: AuthPrincipal,
    @Param('code') code: string,
    @Body() dto: UpsertTemplateDto,
  ) {
    return this.templates.upsert(this.orgId(principal), principal.userId, code, dto);
  }

  @Delete(':code')
  @RequirePermissions('notifications.manage')
  reset(@CurrentUser() principal: AuthPrincipal, @Param('code') code: string) {
    return this.templates.reset(this.orgId(principal), principal.userId, code);
  }

  @Post(':code/preview')
  @RequirePermissions('notifications.view')
  preview(
    @CurrentUser() principal: AuthPrincipal,
    @Param('code') code: string,
    @Body() dto: PreviewTemplateDto,
  ) {
    return this.templates.preview(this.orgId(principal), code, dto.vars, {
      title: dto.title,
      body: dto.body,
    });
  }
}
