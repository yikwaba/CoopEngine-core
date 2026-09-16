import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, SessionTokens } from './auth.service';
import { clearSessionCookies, readRefreshCookie, setSessionCookies } from '../common/auth-cookies';
import { ENV } from '../config/env';
import {
  LoginDto,
  MfaDisableDto,
  MfaLoginVerifyDto,
  MfaVerifySetupDto,
  RefreshDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

interface LoginResult {
  user: { id: string; email: string };
  organizations: { id: string; slug: string; name: string; roleCodes: string[] }[];
  requiresOrgSelection: boolean;
  requiresMfa: boolean;
  mfaToken?: string;
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const ip = request.ip ?? 'unknown';
    const ua = request.headers['user-agent'];
    const auth = await this.authService.authenticate(
      dto.email,
      dto.password,
      ip,
    );

    if (auth.mfaEnabled) {
      const mfaToken = await this.authService.createMfaChallenge(auth.id);
      return {
        user: { id: auth.id, email: auth.email },
        organizations: auth.organizations,
        requiresOrgSelection: false,
        requiresMfa: true,
        mfaToken,
      };
    }

    const outcome = await this.authService.issueForUser(
      auth.id,
      dto.organizationSlug,
      ip,
      ua,
    );
    void this.authService.recordAudit(
      outcome.tokens?.organization?.id ?? null,
      auth.id,
      'auth.login.success',
      'user',
      auth.id,
    );
    // The browser takes the session as an httpOnly cookie. The tokens stay in the body for
    // scripts, tests and callbacks, and the guards accept either.
    if (outcome.tokens) {
      setSessionCookies(res, outcome.tokens, ENV.jwtAccessTtlSeconds);
    }
    return {
      user: { id: auth.id, email: auth.email },
      organizations: auth.organizations,
      requiresOrgSelection: outcome.requiresOrgSelection,
      requiresMfa: false,
      tokens: outcome.tokens,
    };
  }

  /** Second factor step: verify TOTP + challenge, then issue tokens. */
  @Post('mfa/login-verify')
  @HttpCode(HttpStatus.OK)
  async mfaLoginVerify(
    @Body() dto: MfaLoginVerifyDto,
    @Req() request: { ip?: string; headers: { 'user-agent'?: string } },
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const ip = request.ip ?? 'unknown';
    const ua = request.headers['user-agent'];
    const userId = await this.authService.verifyMfaChallenge(
      dto.mfaToken,
      dto.code,
    );
    const user = await this.authService.findUserById(userId);
    const outcome = await this.authService.issueForUser(
      userId,
      dto.organizationSlug,
      ip,
      ua,
    );
    if (outcome.tokens) {
      setSessionCookies(res, outcome.tokens, ENV.jwtAccessTtlSeconds);
    }
    return {
      user: { id: userId, email: user?.email ?? '' },
      organizations: outcome.organizations,
      requiresOrgSelection: outcome.requiresOrgSelection,
      requiresMfa: false,
      tokens: outcome.tokens,
    };
  }

  // --------------------------------------------------- MFA management (authed)

  @Post('mfa/setup')
  @UseGuards(JwtAuthGuard)
  async setupMfa(@CurrentUser() principal: AuthPrincipal) {
    const user = await this.authService.findUserById(principal.userId);
    return this.authService.setupMfa(principal.userId, user?.email ?? '');
  }

  @Post('mfa/verify-setup')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async verifyMfaSetup(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: MfaVerifySetupDto,
  ): Promise<void> {
    await this.authService.verifyMfaSetup(principal.userId, dto.code);
  }

  @Post('mfa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async disableMfa(
    @CurrentUser() principal: AuthPrincipal,
    @Body() dto: MfaDisableDto,
  ): Promise<void> {
    await this.authService.disableMfa(principal.userId, dto.code);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: { headers?: { cookie?: string } },
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionTokens> {
    // A browser has no token to send in the body: it presents the refresh cookie.
    const presented = dto?.refreshToken || readRefreshCookie(request as never);
    if (!presented) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokens = await this.authService.rotateRefresh(presented);
    setSessionCookies(res, tokens, ENV.jwtAccessTtlSeconds);
    return tokens;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentUser() principal: AuthPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    clearSessionCookies(res);
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
