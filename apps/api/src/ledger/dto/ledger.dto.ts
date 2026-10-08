import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
  Validate,
} from 'class-validator';

import {JournalAmountValidator} from '../ledger-money';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class JournalLineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  accountCode!: string;

  @IsOptional()
  @Validate(JournalAmountValidator)
  debit?: number | string;

  @IsOptional()
  @Validate(JournalAmountValidator)
  credit?: number | string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  memo?: string;

  @IsOptional()
  @IsUUID()
  memberId?: string;
}

import { FinancialWriteDto } from '../../common/dto/financial-write.dto';
export class CreateJournalDto extends FinancialWriteDto {
  @IsString()
  @Matches(DATE_RE, { message: 'entryDate must be YYYY-MM-DD' })
  entryDate!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(255)
  description!: string;

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
