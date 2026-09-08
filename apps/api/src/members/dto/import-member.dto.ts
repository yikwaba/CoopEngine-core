import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class PreviewImportDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MinLength(1)
  csv!: string;
}

export class CommitImportDto {
  @IsUUID()
  batchId!: string;
}
