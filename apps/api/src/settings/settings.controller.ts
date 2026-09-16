import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * A cooperative's own settings — currently the security switches that decide whether staff
 * must use two-factor authentication and whether money actions need step-up verification.
 */
@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermissions('settings.manage')
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.settings.get(this.requireOrg(principal));
  }

  @Patch()
  @RequirePermissions('settings.manage')
  update(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(this.requireOrg(principal), principal.userId, dto);
  }

  private requireOrg(principal: AuthPrincipal): string {
    if (!principal.organizationId) {
      throw new BadRequestException(
        'Settings belong to a cooperative: sign in with a cooperative selected',
      );
    }
    return principal.organizationId;
  }
}
