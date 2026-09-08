import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService, SessionTokens } from './auth.service';
import { LoginDto, RefreshDto } from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

interface LoginResult {
  user: { id: string; email: string };
  organizations: { id: string; slug: string; name: string; roleCodes: string[] }[];
  requiresOrgSelection: boolean;
  tokens?: SessionTokens;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: { ip?: string; headers: { 'user-agent'?: string } },
  ): Promise<LoginResult> {
    const { user, organizations } = await this.authService.authenticate(
      dto.email,
      dto.password,
    );
    void this.authService.recordAudit(
      null,
      user.id,
      'auth.login.success',
      'user',
      user.id,
    );

    // Platform (saas) user with no org memberships -> org-less token.
    if (organizations.length === 0 && dto.organizationSlug === undefined) {
      const tokens = await this.authService.issueTokens(
        user.id,
        undefined,
        request.ip,
        request.headers['user-agent'],
      );
      return {
        user,
        organizations,
        requiresOrgSelection: false,
        tokens,
      };
    }

    // Single org -> auto-select.
    if (organizations.length === 1 && dto.organizationSlug === undefined) {
      const single = organizations[0] as { slug: string };
      const tokens = await this.authService.issueTokens(
        user.id,
        single.slug,
        request.ip,
        request.headers['user-agent'],
      );
      return {
        user,
        organizations,
        requiresOrgSelection: false,
        tokens,
      };
    }

    // Explicit slug requested.
    if (dto.organizationSlug) {
      const tokens = await this.authService.issueTokens(
        user.id,
        dto.organizationSlug,
        request.ip,
        request.headers['user-agent'],
      );
      return {
        user,
        organizations,
        requiresOrgSelection: false,
        tokens,
      };
    }

    // Multiple orgs, no slug -> client must choose.
    return { user, organizations, requiresOrgSelection: true };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto): Promise<SessionTokens> {
    return this.authService.rotateRefresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() principal: AuthPrincipal): Promise<void> {
    await this.authService.revokeSession(principal.sessionId);
    await this.authService.recordAudit(
      principal.organizationId,
      principal.userId,
      'auth.logout',
      'session',
      principal.sessionId,
    );
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() principal: AuthPrincipal) {
    const user = await this.authService.findUserById(principal.userId);
    return {
      user,
      organizationId: principal.organizationId,
      sessionId: principal.sessionId,
      permissions: principal.permissions,
    };
  }
}
