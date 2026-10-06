import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** HTTP callers retain one key for one financial intent; internal services own source keys. */
export class FinancialWriteDto {
  @ApiProperty({ required: true, minLength: 16, maxLength: 100,
    description: 'Client-generated retry key. Reuse the same key and original details after a timeout. Generate a new key only for a new payment. pay: and withdrawal-request: prefixes are reserved for internal source links.',
    example: 'e6c5ad8f-d2c3-4d22-9457-604f2aef4f35' })
  @IsDefined({ message: 'idempotencyKey is required for financial requests; reuse it when retrying' })
  @IsString()
  @MinLength(16)
  @MaxLength(100)
  @Matches(/^(?!pay:|withdrawal-request:)(?=.*\S)[\s\S]+$/s, {
    message: 'idempotencyKey must be nonblank; pay: and withdrawal-request: prefixes are reserved',
  })
  idempotencyKey!: string;
}
