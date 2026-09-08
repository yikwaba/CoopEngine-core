import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  organizationSlug?: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}

const TOTP_CODE = /^\d{6}$/;

export class MfaSetupResponseDto {
  secret!: string;
  otpauthUrl!: string;
}

export class MfaVerifySetupDto {
  @IsString()
  @Matches(TOTP_CODE, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}

export class MfaDisableDto {
  @IsString()
  @Matches(TOTP_CODE, { message: 'code must be a 6-digit TOTP code' })
  code!: string;
}

export class MfaLoginVerifyDto {
  @IsString()
  @MinLength(16)
  mfaToken!: string;

  @IsString()
  @Matches(TOTP_CODE, { message: 'code must be a 6-digit TOTP code' })
  code!: string;

  @IsOptional()
  @IsString()
  organizationSlug?: string;
}
