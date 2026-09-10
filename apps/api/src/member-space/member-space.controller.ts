import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsUUID, Max, Min } from 'class-validator';
import { MemberSpaceService } from './member-space.service';
import { MemberJwtGuard } from '../common/guards/member-jwt.guard';
import { CurrentMember } from '../common/decorators/current-member.decorator';
import { MemberPrincipal } from '../common/guards/member-jwt.guard';

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
  constructor(private readonly memberSpaceService: MemberSpaceService) {}

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
