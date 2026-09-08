import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class JournalLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  accountCode!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  debit?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  credit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  memo?: string;

  @IsOptional()
  @IsUUID()
  memberId?: string;
}

export class CreateJournalDto {
  @IsString()
  @Matches(DATE_RE, { message: 'entryDate must be YYYY-MM-DD' })
  entryDate!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(255)
  description!: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(100)
  idempotencyKey?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

export class PeriodQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period?: string;
}

export class JournalStatusQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'SUBMITTED', 'POSTED', 'REVERSED'])
  status?: string;
}

export type { JournalStatusQueryDto as JournalStatusDto };
