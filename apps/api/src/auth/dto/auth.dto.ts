import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

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

export class SelectOrgDto {
  @IsOptional()
  @IsString()
  organizationSlug?: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}
