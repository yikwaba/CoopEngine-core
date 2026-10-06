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
import { PasswordResetService } from './password-reset.service';
import { ENV } from '../config/env';
import { MfaFlowService } from './mfa-flow.service';
import {
  LoginDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  MfaDisableDto,
  MfaLoginVerifyDto,
  MfaRecoveryDto,
  MfaRecoveryCodesDto,
  MfaVerifySetupDto,
  RefreshDto,
} from './dto/auth.dto';
import { SessionLogoutGuard } from '../common/guards/session-logout.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';

interface LoginResult {
  user: { id: string; email: string };
  organizations: { id: string; slug: string; name: string; roleCodes: string[] }[];
  requiresOrgSelection: boolean;
  requiresMfa: boolean;
  mfaToken?: string;
  requiresMfaEnrollment?: boolean;
  enrollment?: { secret: string; otpauthUrl: string };
  recoveryCodes?: string[];
  tokens?: SessionTokens;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService, private readonly passwordReset: PasswordResetService, private readonly mfaFlow: MfaFlowService) {}

  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  requestPasswordReset(@Body() dto: RequestPasswordResetDto, @Req() request: { ip?: string }) {
    return this.passwordReset.request(dto.email, request.ip ?? 'unknown');
  }

  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmPasswordReset(@Body() dto: ResetPasswordDto, @Res({ passthrough: true }) res: Response) {
    await this.passwordReset.reset(dto.token, dto.password);
    clearSessionCookies(res);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() request: { ip?: string; headers: { 'user-agent'?: string } },
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const ip = request.ip ?? 'unknown';
    const ua = request.headers['user-agent'];
    res.setHeader('Cache-Control', 'no-store');
    const auth = await this.authService.authenticate(
      dto.email,
      dto.password,
      ip,
    );

    if (auth.mfaEnabled) {
      const mfaToken = await this.authService.createMfaChallenge(auth.id, auth.authVersion);
      return {
        user: { id: auth.id, email: auth.email },
        organizations: auth.organizations,
        requiresOrgSelection: false,
        requiresMfa: true,
        mfaToken,
      };
    }

    if (await this.authService.requiresMfa(auth.id)) {
      const start = await this.mfaFlow.start(auth.id, auth.authVersion, 'ENROLL');
      clearSessionCookies(res);
      return { user: { id: auth.id, email: auth.email }, organizations: auth.organizations,
        requiresOrgSelection: false, requiresMfa: false, requiresMfaEnrollment: true, ...start };
    }

    const outcome = await this.authService.issueForUser(
      auth.id,
      dto.organizationSlug,
      ip,
      ua,
      { authVersion: auth.authVersion, mfaVerified: false },
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
    res.setHeader('Cache-Control', 'no-store');
    const { userId, proof } = await this.authService.verifyMfaChallenge(
      dto.mfaToken,
      dto.code,
    );
    const user = await this.authService.findUserById(userId);
    const outcome = await this.authService.issueForUser(
      userId,
      dto.organizationSlug,
      ip,
      ua,
      proof,
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

  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  async enrollMfa(@Body() dto: MfaLoginVerifyDto, @Req() request: { ip?: string; headers: { 'user-agent'?: string } }, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control','no-store');
    const { userId, proof } = await this.mfaFlow.verify(dto.mfaToken, dto.code, 'ENROLL');
    const outcome = await this.authService.issueForUser(userId, dto.organizationSlug, request.ip, request.headers['user-agent'], proof);
    if (outcome.tokens) setSessionCookies(res, outcome.tokens, ENV.jwtAccessTtlSeconds);
    return { ...outcome, requiresMfa: false };
  }

  @Post('mfa/recover')
  @HttpCode(HttpStatus.OK)
  async recoverMfa(@Body() dto: MfaRecoveryDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control','no-store');
    const start = await this.mfaFlow.recover(dto.mfaToken, dto.recoveryCode);
    clearSessionCookies(res);
    return { ...start, requiresMfaEnrollment: true };
  }

  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async recoveryCodes(@CurrentUser() principal: AuthPrincipal, @Body() dto: MfaRecoveryCodesDto, @Req() req: { ip?: string }, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control','no-store');
    const user = await this.authService.findUserById(principal.userId);
    if (!user) throw new UnauthorizedException();
    const auth = await this.authService.authenticate(user.email, dto.password, req.ip);
    const challenge = await this.mfaFlow.start(auth.id, auth.authVersion, 'LOGIN');
    const { proof } = await this.mfaFlow.verify(challenge.mfaToken, dto.code, 'LOGIN');
    return { recoveryCodes: await this.mfaFlow.change(auth.id, proof, 'codes') };
  }

  // --------------------------------------------------- MFA management (authed)

  @Post('mfa/setup')
  @UseGuards(JwtAuthGuard)
  async setupMfa(@CurrentUser() principal: AuthPrincipal, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.disableMfa(principal.userId, dto.code);
    clearSessionCookies(res);
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
  @UseGuards(SessionLogoutGuard)
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
    const organizations = await this.authService.listOrganizations(principal.userId);
    return {
      user,
      organizationId: principal.organizationId,
      organizationSlug: organizations.find(org => org.id === principal.organizationId)?.slug ?? null,
      sessionId: principal.sessionId,
      financialScope: `${principal.organizationId}:${principal.userId}`,
      permissions: principal.permissions,
    };
  }
}
