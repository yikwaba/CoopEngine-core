import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

export interface BranchRow {
  id: string;
  name: string;
  code: string | null;
  isHeadquarters: boolean;
  memberCount: number;
}

@Injectable()
export class BranchesService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  async list(organizationId: string | null): Promise<BranchRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT b.id, b.name, b.code, b.is_headquarters,
                (SELECT count(*) FROM members m WHERE m.branch_id = b.id) AS member_count
           FROM branches b
          ORDER BY b.is_headquarters DESC, b.name`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        code: (r.code as string | null) ?? null,
        isHeadquarters: Boolean(r.is_headquarters),
        memberCount: Number(r.member_count),
      }));
    });
  }

  async create(
    organizationId: string | null,
    actorUserId: string,
    input: { name: string; code?: string; isHeadquarters?: boolean },
  ): Promise<{ id: string }> {
    const orgId = this.requireOrg(organizationId);
    if (!input.name?.trim()) throw new BadRequestException('Branch name is required');
    return withTenant(this.pool, orgId, async (c) => {
      const dup = await c.query(
        `SELECT 1 FROM branches WHERE lower(name) = lower($1)`,
        [input.name.trim()],
      );
      if (dup.rows[0]) throw new ConflictException('A branch with that name already exists');
      if (input.isHeadquarters) {
        await c.query(`UPDATE branches SET is_headquarters = false WHERE is_headquarters`);
      }
      const { rows } = await c.query(
        `INSERT INTO branches (organization_id, name, code, is_headquarters)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [orgId, input.name.trim(), input.code?.trim() || null, input.isHeadquarters ?? false],
      );
      const id = (rows[0] as { id: string }).id;
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'branch.created', 'branch', $3, $4)`,
        [orgId, actorUserId, id, JSON.stringify({ name: input.name })],
      );
      return { id };
    });
  }

  async update(
    organizationId: string | null,
    actorUserId: string,
    branchId: string,
    input: { name?: string; code?: string; isHeadquarters?: boolean },
  ): Promise<BranchRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const existing = await c.query(`SELECT id FROM branches WHERE id = $1`, [branchId]);
      if (!existing.rows[0]) throw new NotFoundException('Branch not found');
      if (input.isHeadquarters) {
        await c.query(`UPDATE branches SET is_headquarters = false WHERE is_headquarters`);
      }
      await c.query(
        `UPDATE branches
            SET name = coalesce($2, name),
                code = coalesce($3, code),
                is_headquarters = coalesce($4, is_headquarters),
                updated_at = now()
          WHERE id = $1`,
        [
          branchId,
          input.name?.trim() ?? null,
          input.code?.trim() ?? null,
          input.isHeadquarters ?? null,
        ],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'branch.updated', 'branch', $3, $4)`,
        [orgId, actorUserId, branchId, JSON.stringify(input)],
      );
      const rows = await this.list(orgId);
      const row = rows.find((b) => b.id === branchId);
      if (!row) throw new NotFoundException('Branch not found');
      return row;
    });
  }

  /** Assign (or clear) a member's branch. */
  async assignMember(
    organizationId: string | null,
    actorUserId: string,
    memberId: string,
    branchId: string | null,
  ): Promise<{ memberId: string; branchId: string | null }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      if (branchId) {
        const b = await c.query(`SELECT id FROM branches WHERE id = $1`, [branchId]);
        if (!b.rows[0]) throw new NotFoundException('Branch not found');
      }
      const res = await c.query(`UPDATE members SET branch_id = $2 WHERE id = $1`, [
        memberId,
        branchId,
      ]);
      if (!res.rowCount) throw new NotFoundException('Member not found');
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'member.branch.assigned', 'member', $3, $4)`,
        [orgId, actorUserId, memberId, JSON.stringify({ branchId })],
      );
      return { memberId, branchId };
    });
  }
}

class BranchDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @IsOptional()
  @IsBoolean()
  isHeadquarters?: boolean;
}

class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @IsOptional()
  @IsBoolean()
  isHeadquarters?: boolean;
}

class AssignBranchDto {
  @IsOptional()
  @IsString()
  branchId?: string | null;
}

@Controller('branches')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @RequirePermissions('branches.view')
  list(@CurrentUser() user: AuthPrincipal) {
    return this.branchesService.list(user.organizationId);
  }

  @Post()
  @RequirePermissions('branches.manage', 'settings.manage')
  create(@CurrentUser() user: AuthPrincipal, @Body() dto: BranchDto) {
    return this.branchesService.create(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('branches.manage', 'settings.manage')
  update(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchesService.update(user.organizationId, user.userId, id, dto);
  }

  @Post('members/:memberId/assign')
  @RequirePermissions('branches.manage')
  assign(
    @CurrentUser() user: AuthPrincipal,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Body() dto: AssignBranchDto,
  ) {
    return this.branchesService.assignMember(
      user.organizationId,
      user.userId,
      memberId,
      dto.branchId ?? null,
    );
  }
}

@Module({
  imports: [AuthModule],
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
