import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { clearSessionCookies, setSessionCookies } from '../common/auth-cookies';
import { ENV } from '../config/env';
import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { MemberAuthService } from './member-auth.service';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class RequestOtpDto {
  @IsString()
  @Matches(SLUG_RE)
  organizationSlug!: string;

  @IsEmail()
  email!: string;
}

class VerifyOtpDto {
  @IsString()
  @Matches(SLUG_RE)
  organizationSlug!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code!: string;
}

@Controller('auth/member')
export class MemberAuthController {
  constructor(private readonly memberAuthService: MemberAuthService) {}

  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.memberAuthService.requestOtp(dto.organizationSlug, dto.email);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.memberAuthService.verifyOtp(
      dto.organizationSlug,
      dto.email,
      dto.code,
    );
    // The member app is a browser too, and a member's session is worth just as much: it goes in
    // an httpOnly cookie, with the token still in the body for anything non-browser.
    setSessionCookies(res, { accessToken: session.accessToken }, ENV.jwtAccessTtlSeconds);
    return session;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    // Member access tokens are deliberately short-lived and are not backed by a refresh session.
    // Removing the httpOnly cookies ends the browser session without exposing the token to JS.
    clearSessionCookies(res);
  }
}
