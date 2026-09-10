import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../common/auth.types';
import { DOC_TYPES, DocumentsService } from './documents.service';

class UploadDocumentDto {
  @IsIn(DOC_TYPES)
  docType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(100)
  mimeType!: string;

  @IsString()
  @MinLength(4)
  contentBase64!: string;
}

class ReviewDocumentDto {
  @IsIn(['VERIFIED', 'REJECTED'])
  status!: 'VERIFIED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('members/:id/documents')
  @RequirePermissions('members.edit')
  upload(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
    @Body() dto: UploadDocumentDto,
  ) {
    return this.documentsService.upload(user.organizationId, memberId, dto);
  }

  @Get('members/:id/documents')
  @RequirePermissions('members.lookup')
  listForMember(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ) {
    return this.documentsService.list(user.organizationId, { memberId });
  }

  @Get('documents')
  @RequirePermissions('members.lookup')
  list(
    @CurrentUser() user: AuthPrincipal,
    @Query('status') status?: string,
    @Query('memberId') memberId?: string,
  ) {
    return this.documentsService.list(user.organizationId, { status, memberId });
  }

  @Get('documents/:id/download')
  @RequirePermissions('members.lookup')
  async download(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    const { row, content } = await this.documentsService.read(user.organizationId, id);
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.fileName}"`);
    res.setHeader('Content-Length', String(content.length));
    res.end(content);
  }

  @Post('documents/:id/verify')
  @RequirePermissions('members.edit')
  review(
    @CurrentUser() user: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReviewDocumentDto,
  ) {
    return this.documentsService.review(
      user.organizationId,
      user.userId,
      id,
      dto.status,
      dto.notes,
    );
  }
}
