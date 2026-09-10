import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { GoalsService } from './goals.service';

class CreateGoalDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  targetAmount!: number;

  @IsOptional()
  @IsString()
  targetDate?: string;
}

class CreateInstructionDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount!: number;

  @IsIn(['WEEKLY', 'MONTHLY'])
  frequency!: string;

  @IsOptional()
  @IsString()
  nextRunDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

class UpdateInstructionDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'PAUSED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsIn(['WEEKLY', 'MONTHLY'])
  frequency?: string;

  @IsOptional()
  @IsString()
  nextRunDate?: string;
}

@Controller('savings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Get('goals')
  @RequirePermissions('savings.view', 'members.lookup')
  goals(@CurrentUser() user: AuthPrincipal, @Query('memberId') memberId?: string) {
    return this.goalsService.listGoals(user.organizationId, memberId);
  }

  @Post('goals/:memberId')
  @RequirePermissions('members.edit')
  createGoal(
    @CurrentUser() user: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: CreateGoalDto,
  ) {
    return this.goalsService.createGoal(user.organizationId, memberId, dto);
  }

  @Patch('goals/:id/cancel')
  @RequirePermissions('members.edit')
  cancelGoal(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.goalsService.cancelGoal(user.organizationId, id);
  }

  @Get('standing-instructions')
  @RequirePermissions('savings.view', 'members.lookup')
  instructions(@CurrentUser() user: AuthPrincipal, @Query('memberId') memberId?: string) {
    return this.goalsService.listInstructions(user.organizationId, memberId);
  }

  @Post('standing-instructions/:memberId')
  @RequirePermissions('members.edit')
  createInstruction(
    @CurrentUser() user: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: CreateInstructionDto,
  ) {
    return this.goalsService.createInstruction(user.organizationId, memberId, dto);
  }

  @Patch('standing-instructions/:id')
  @RequirePermissions('members.edit')
  updateInstruction(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateInstructionDto,
  ) {
    return this.goalsService.updateInstruction(user.organizationId, id, dto);
  }
}

/** Token-guarded sweep used by the nightly timer. */
@Controller('internal/savings')
export class GoalsInternalController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly goalsService: GoalsService,
  ) {}

  /** Enumerate tenant ids via the narrow internal scan policy. */
  private async allOrgIds(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const { rows } = await client.query(`SELECT id FROM organizations ORDER BY created_at`);
      await client.query('COMMIT');
      return (rows as { id: string }[]).map((r) => r.id);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  @Post('sweep')
  async sweep(@Headers('x-internal-token') token: string | undefined) {
    const expected = process.env.INTERNAL_CRON_TOKEN ?? '';
    if (!expected || token !== expected) {
      throw new UnauthorizedException('Invalid internal token');
    }
    const orgIds = await this.allOrgIds();
    let reminded = 0;
    for (const orgId of orgIds) {
      const result = await this.goalsService.sweepDue(orgId, null);
      reminded += result.reminded;
    }
    return { organizations: orgIds.length, reminded };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [GoalsController, GoalsInternalController],
  providers: [GoalsService],
  exports: [GoalsService],
})
export class GoalsModule {}
