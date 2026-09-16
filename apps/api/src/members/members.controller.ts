import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { MembersService, MemberRow, NextOfKinRow } from './members.service';
import {
  MemberImportService,
  ImportPreviewResult,
  ImportCommitResult,
} from './member-import.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { CommitImportDto, PreviewImportDto } from './dto/import-member.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

/**
 * Reading members requires the READ permission.
 *
 * This used to list the mutation permissions (approve/create/edit/import/export), with two
 * consequences: a role holding the actual read permission but no mutation rights could not
 * read members at all — the treasurer, loan officer and auditor were all locked out of the
 * member list — and a role could read members only if it could also change them.
 */
const READ_PERMISSIONS = ['members.lookup'];

@Controller('members')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MembersController {
  constructor(
    private readonly membersService: MembersService,
    private readonly memberImportService: MemberImportService,
  ) {}

  @Post()
  @RequirePermissions('members.create')
  create(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CreateMemberDto,
  ): Promise<MemberRow> {
    return this.membersService.create(
      principal.organizationId,
      principal.userId,
      dto,
    );
  }

  @Get()
  @RequirePermissions(...READ_PERMISSIONS)
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
  ) {
    const { items, total } = await this.membersService.list(
      principal.organizationId,
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
      q,
    );
    res.setHeader('X-Total-Count', String(total));
    return items;
  }

  @Get(':id')
  @RequirePermissions(...READ_PERMISSIONS)
  get(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ): Promise<MemberRow> {
    return this.membersService.get(principal.organizationId, memberId);
  }

  @Get(':id/next-of-kin')
  @RequirePermissions(...READ_PERMISSIONS)
  nextOfKin(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ): Promise<NextOfKinRow[]> {
    return this.membersService.listNextOfKin(
      principal.organizationId,
      memberId,
    );
  }

  /** PENDING -> ACTIVE (records joined_at). Requires members.approve. */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.approve')
  approve(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ): Promise<MemberRow> {
    return this.membersService.transition(
      principal.organizationId,
      principal.userId,
      memberId,
      'ACTIVE',
    );
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.edit')
  suspend(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ): Promise<MemberRow> {
    return this.membersService.transition(
      principal.organizationId,
      principal.userId,
      memberId,
      'SUSPENDED',
    );
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.edit')
  reactivate(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ): Promise<MemberRow> {
    return this.membersService.transition(
      principal.organizationId,
      principal.userId,
      memberId,
      'ACTIVE',
    );
  }

  @Post(':id/exit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.edit')
  exit(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ) {
    return this.membersService.exitMember(
      principal.organizationId,
      principal.userId,
      memberId,
    );
  }

  // ----------------------------------------------------------- bulk import

  @Post('import/preview')
  @RequirePermissions('members.import')
  previewImport(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: PreviewImportDto,
  ): Promise<ImportPreviewResult> {
    return this.memberImportService.preview(
      principal.organizationId,
      principal.userId,
      dto.filename,
      dto.csv,
    );
  }

  @Post('import/commit')
  @RequirePermissions('members.import')
  commitImport(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: CommitImportDto,
  ): Promise<ImportCommitResult> {
    return this.memberImportService.commit(
      principal.organizationId,
      principal.userId,
      dto.batchId,
    );
  }
}
