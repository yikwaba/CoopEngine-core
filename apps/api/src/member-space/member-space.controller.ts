import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MemberSpaceService } from './member-space.service';
import { DocumentsService } from '../documents/documents.service';
import type { Response } from 'express';
import { MemberJwtGuard } from '../common/guards/member-jwt.guard';
import { CurrentMember } from '../common/decorators/current-member.decorator';
import { MemberPrincipal } from '../common/guards/member-jwt.guard';

class MemberDocumentDto {
  @IsIn(['ID_CARD', 'UTILITY_BILL', 'PASSPORT', 'SIGNATURE', 'OTHER'])
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

class NotificationReadDto {
  @IsOptional()
  @IsUUID()
  id?: string;
}

class GuarantorResponseDto {
  @IsBoolean()
  accept!: boolean;
}

class LoanApplyDto {
  @IsUUID()
  loanProductId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100_000_000_000)
  principal!: number;

  @IsNumber()
  @Min(1)
  @Max(60)
  termMonths!: number;
}

@Controller('member')
@UseGuards(MemberJwtGuard)
export class MemberSpaceController {
  constructor(
    private readonly memberSpaceService: MemberSpaceService,
    private readonly documentsService: DocumentsService,
  ) {}

  @Get('me')
  me(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.me(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Get('dashboard')
  dashboard(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.dashboard(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Get('virtual-account')
  virtualAccount(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.virtualAccount(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Get('payments')
  payments(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myPayments(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Post('documents')
  uploadDocument(
    @CurrentMember() principal: MemberPrincipal,
    @Body() dto: MemberDocumentDto,
  ) {
    return this.documentsService.upload(
      principal.organizationId,
      principal.memberId,
      dto,
      { byMember: true },
    );
  }

  @Get('documents')
  documents(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myDocuments(principal.organizationId, principal.memberId);
  }

  @Get('notifications')
  notifications(
    @CurrentMember() principal: MemberPrincipal,
    @Res({ passthrough: true }) res: Response,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.memberSpaceService
      .listMyNotifications(
        principal.organizationId,
        principal.memberId,
        limit ? Number(limit) : 50,
        offset ? Number(offset) : 0,
      )
      .then((r) => {
        res.setHeader('X-Total-Count', String(r.total));
        return r;
      });
  }

  @Post('notifications/read')
  notificationsRead(
    @CurrentMember() principal: MemberPrincipal,
    @Body() dto: NotificationReadDto,
  ) {
    return this.memberSpaceService.markNotificationRead(
      principal.organizationId,
      principal.memberId,
      dto.id,
    );
  }

  @Get('dividends')
  dividends(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myDividends(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Get('guarantor-requests')
  guarantorRequests(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myGuarantorRequests(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Post('guarantor-requests/:id/respond')
  respondGuarantor(
    @CurrentMember() principal: MemberPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: GuarantorResponseDto,
  ) {
    return this.memberSpaceService.respondGuarantor(
      principal.organizationId,
      principal.memberId,
      id,
      dto.accept,
    );
  }

  @Get('loan-products')
  loanProducts(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.loanProducts(principal.organizationId);
  }

  @Get('loans')
  loans(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myLoans(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Post('loans/apply')
  applyLoan(
    @CurrentMember() principal: MemberPrincipal,
    @Body() dto: LoanApplyDto,
  ) {
    return this.memberSpaceService.applyForLoan(
      principal.organizationId,
      principal.memberId,
      dto,
    );
  }
}
