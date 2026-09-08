import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MembersService, MemberRow, NextOfKinRow } from './members.service';
import { CreateMemberDto } from './dto/create-member.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

const READ_PERMISSIONS = [
  'members.approve',
  'members.create',
  'members.edit',
  'members.import',
  'members.export',
];

@Controller('members')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

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
  list(@CurrentUser() principal: AuthPrincipal): Promise<MemberRow[]> {
    return this.membersService.list(principal.organizationId);
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
  ): Promise<MemberRow> {
    return this.membersService.transition(
      principal.organizationId,
      principal.userId,
      memberId,
      'EXITED',
    );
  }
}
