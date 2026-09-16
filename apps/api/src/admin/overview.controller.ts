import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OverviewController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @RequirePermissions('saas.platform.health')
  overview() {
    return this.admin.overview();
  }
}
