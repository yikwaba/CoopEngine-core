import { IsEmail, IsString, Matches, MinLength } from 'class-validator';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateOrganizationDto {
  @IsString()
  @MinLength(3)
  name!: string;

  @IsString()
  @Matches(SLUG_PATTERN, {
    message:
      'slug must be lowercase alphanumeric words joined by single hyphens (e.g. nysc-coop)',
  })
  slug!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(8)
  adminPassword!: string;
}
