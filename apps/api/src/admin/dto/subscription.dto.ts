import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class AssignSubscriptionDto {
  /** Either a plan code (STARTER) or a plan id — the console works with both. */
  @IsOptional()
  @IsString()
  planCode?: string;

  @IsOptional()
  @IsUUID()
  planId?: string;

  @IsOptional()
  @IsIn(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'renewsAt must be a date (YYYY-MM-DD)' })
  renewsAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
