import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Security switches a cooperative can turn on for itself.
 *
 * Deliberately an explicit shape rather than "send any JSON": settings steer sign-in and
 * money actions, so an unvalidated write here would be a way around the controls.
 */
export class SecuritySettingsDto {
  @IsOptional()
  @IsBoolean()
  mfaRequiredForPrivilegedRoles?: boolean;

  @IsOptional()
  @IsBoolean()
  requireStepUpForSensitiveMoney?: boolean;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SecuritySettingsDto)
  security?: SecuritySettingsDto;
}
