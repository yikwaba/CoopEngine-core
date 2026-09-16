import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AdminService } from './admin.service';
import { AssignSubscriptionDto } from './dto/subscription.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

/** The cooperatives on the platform, as the platform operator sees them. */
@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TenantsController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @RequirePermissions('saas.tenants.manage')
  list(@Query('q') q?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.admin.listTenants({
      q,
      limit: Math.min(Number(limit) || 25, 100),
      offset: Number(offset) || 0,
    });
  }

  @Get(':id')
  @RequirePermissions('saas.tenants.manage')
  tenant(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.tenant(id);
  }

  @Patch(':id')
  @RequirePermissions('saas.tenants.manage')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.admin.updateTenant(id, dto, principal.userId);
  }

  @Get(':id/subscription')
  @RequirePermissions('saas.billing.manage')
  subscription(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.subscriptionHistory(id);
  }

  @Post(':id/subscription')
  @RequirePermissions('saas.billing.manage')
  assign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignSubscriptionDto,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.admin.assignSubscription(id, dto, principal.userId);
  }
}
