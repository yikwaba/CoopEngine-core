import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsString,
  ArrayNotEmpty,
  MaxLength,
} from 'class-validator';
import { OrgUsersService } from './org-users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  roleCodes!: string[];
}

class RolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  roleCodes!: string[];
}

class StatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status!: 'ACTIVE' | 'SUSPENDED';
}

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrgUsersController {
  constructor(private readonly orgUsersService: OrgUsersService) {}

  @Get()
  @RequirePermissions('users.manage')
  list(@CurrentUser() principal: AuthPrincipal) {
    return this.orgUsersService.list(principal.organizationId);
  }

  @Post()
  @RequirePermissions('users.manage')
  invite(@CurrentUser() principal: AuthPrincipal, @Body() dto: InviteUserDto) {
    return this.orgUsersService.invite(
      principal.organizationId,
      principal.userId,
      dto.email,
      dto.roleCodes,
    );
  }

  @Patch('roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users.manage')
  replaceRoles(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: { email: string } & RolesDto,
  ) {
    return this.orgUsersService.replaceRoles(
      principal.organizationId,
      principal.userId,
      dto.email,
      dto.roleCodes,
    );
  }

  @Patch('status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users.manage')
  setStatus(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: { email: string } & StatusDto,
  ) {
    return this.orgUsersService.setStatus(
      principal.organizationId,
      principal.userId,
      dto.email,
      dto.status,
    );
  }
}
