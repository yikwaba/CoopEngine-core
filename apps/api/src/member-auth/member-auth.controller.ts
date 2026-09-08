import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
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
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.memberAuthService.verifyOtp(
      dto.organizationSlug,
      dto.email,
      dto.code,
    );
  }
}
