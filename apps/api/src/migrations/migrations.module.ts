import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { OpeningBalancesService } from './opening-balances.service';

class PreviewOpeningBalancesDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @IsString()
  @MinLength(1)
  csv!: string;
}

@Controller('migrations/opening-balances')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OpeningBalancesController {
  constructor(private readonly service: OpeningBalancesService) {}

  @Get()
  @RequirePermissions('migrations.view', 'settings.manage')
  list(@CurrentUser() user: AuthPrincipal) {
    return this.service.list(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions('migrations.view', 'settings.manage')
  get(@CurrentUser() user: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.get(user.organizationId, id);
  }

  @Post('preview')
  @RequirePermissions('migrations.manage', 'settings.manage')
  preview(@CurrentUser() user: AuthPrincipal, @Body() dto: PreviewOpeningBalancesDto) {
    return this.service.preview(
      user.organizationId,
      user.userId,
      dto.label,
      dto.filename,
      dto.csv,
    );
  }

  @Post(':id/commit')
  @RequirePermissions('migrations.manage', 'settings.manage')
  commit(@CurrentUser() user: AuthPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.commit(user.organizationId, user.userId, id);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [OpeningBalancesController],
  providers: [OpeningBalancesService],
  exports: [OpeningBalancesService],
})
export class MigrationsModule {}
