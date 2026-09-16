import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTenantDto {
  /** SUSPENDED stops sign-in for that cooperative without touching its data. */
  @IsOptional()
  @IsIn(['ACTIVE', 'PENDING', 'SUSPENDED'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legalName?: string;
}
