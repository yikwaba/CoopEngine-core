import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { PlansService } from './plans.service';

/** The platform's plan catalogue — SaaS-scope only. */
@Controller('admin/plans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermissions('saas.plans.manage')
  list() {
    return this.plans.list();
  }

  @Post()
  @RequirePermissions('saas.plans.manage')
  create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('saas.plans.manage')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }
}
