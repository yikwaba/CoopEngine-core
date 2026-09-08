import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateLoanDto {
  @IsUUID()
  memberId!: string;

  @IsUUID()
  productId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  principal!: number;

  @IsInt()
  @Min(1)
  @Max(60)
  termMonths!: number;

  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('4', { each: true })
  guarantorIds!: string[];
}

export class RejectLoanDto {
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  reason!: string;
}
