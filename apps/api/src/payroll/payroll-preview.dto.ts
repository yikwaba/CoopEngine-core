import { IsString, MaxLength, MinLength } from 'class-validator';
import { FinancialWriteDto } from '../common/dto/financial-write.dto';

/** A new key means a deliberately new upload; retries must retain filename and CSV. */
export class PayrollPreviewDto extends FinancialWriteDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(16000)
  csv!: string;
}
