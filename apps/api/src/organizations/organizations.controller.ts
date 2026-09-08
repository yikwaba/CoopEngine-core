import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { OrganizationsService, OnboardedOrganization } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

@Controller('organizations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @RequirePermissions('saas.tenants.manage')
  async create(
    @Body() dto: CreateOrganizationDto,
    @CurrentUser() principal: AuthPrincipal,
  ): Promise<OnboardedOrganization> {
    void principal; // actor recorded inside the service audit row
    return this.organizationsService.onboard(dto);
  }
}
