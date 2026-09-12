import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MemberSpaceService } from './member-space.service';
import { DocumentsService } from '../documents/documents.service';
import { GoalsService } from '../goals/goals.service';
import { PdfService } from '../pdf/pdf.service';
import type { Response } from 'express';
import { MemberJwtGuard } from '../common/guards/member-jwt.guard';
import { CurrentMember } from '../common/decorators/current-member.decorator';
import { MemberPrincipal } from '../common/guards/member-jwt.guard';

class MemberGoalDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  targetAmount!: number;

  @IsOptional()
  @IsString()
  targetDate?: string;
}

class MemberInstructionDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount!: number;

  @IsIn(['WEEKLY', 'MONTHLY'])
  frequency!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

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

export class MemberWithdrawalDto {
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsNumber()
  @Min(1)
  amount!: number;

  @IsOptional()
  @IsString()
  description?: string;
}

@Controller('member')
@UseGuards(MemberJwtGuard)


export class MemberSpaceController {
  constructor(
    private readonly memberSpaceService: MemberSpaceService,
    private readonly documentsService: DocumentsService,
    private readonly goalsService: GoalsService,
    private readonly pdfService: PdfService,
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
  async virtualAccount(
    @CurrentMember() principal: MemberPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    // A member often has no virtual account yet, and Nest turns a null return into a
    // response with NO body at all. A browser calling res.json() on that throws
    // "Unexpected end of JSON input", so send an explicit JSON null.
    const account = await this.memberSpaceService.virtualAccount(
      principal.organizationId,
      principal.memberId,
    );
    res.json(account ?? null);
  }

  @Get('savings')
  mySavings(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.mySavings(principal.organizationId, principal.memberId);
  }

  @Get('statements')
  myStatements(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myStatements(principal.organizationId, principal.memberId);
  }

  /** The member's own savings statement as a PDF. */
  @Get('statements/savings.pdf')
  async savingsStatement(
    @CurrentMember() principal: MemberPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdfService.memberStatement(
      principal.organizationId,
      principal.memberId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buffer);
  }

  /** The member's own loan statement as a PDF. */
  @Get('statements/loan.pdf')
  async loanStatement(
    @CurrentMember() principal: MemberPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const loanId = await this.memberSpaceService.myLatestLoanId(
      principal.organizationId,
      principal.memberId,
    );
    if (!loanId) {
      throw new NotFoundException('You have no loan to print a statement for');
    }
    const { buffer, filename } = await this.pdfService.loanStatement(
      principal.organizationId as string,
      loanId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(buffer);
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

  @Get('goals')
  goals(@CurrentMember() principal: MemberPrincipal) {
    return this.goalsService.listGoals(principal.organizationId, principal.memberId);
  }

  @Post('goals')
  createGoal(@CurrentMember() principal: MemberPrincipal, @Body() dto: MemberGoalDto) {
    return this.goalsService.createGoal(principal.organizationId, principal.memberId, dto);
  }

  @Get('standing-instructions')
  instructions(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myInstructions(
      principal.organizationId,
      principal.memberId,
    );
  }

  @Post('standing-instructions')
  createInstruction(
    @CurrentMember() principal: MemberPrincipal,
    @Body() dto: MemberInstructionDto,
  ) {
    return this.goalsService.createInstruction(
      principal.organizationId,
      principal.memberId,
      dto,
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

  @Post('withdrawals/request')
  requestWithdrawal(
    @CurrentMember() principal: MemberPrincipal,
    @Body() dto: MemberWithdrawalDto,
  ) {
    return this.memberSpaceService.requestWithdrawal(
      principal.organizationId,
      principal.memberId,
      dto.accountId,
      dto.amount,
      dto.description,
    );
  }

  @Get('withdrawals')
  myWithdrawals(@CurrentMember() principal: MemberPrincipal) {
    return this.memberSpaceService.myWithdrawalRequests(
      principal.organizationId,
      principal.memberId,
    );
  }

}
