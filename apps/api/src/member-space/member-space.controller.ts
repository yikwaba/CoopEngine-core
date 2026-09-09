import { Controller, Get, UseGuards } from '@nestjs/common';
import { MemberSpaceService } from './member-space.service';
import { MemberJwtGuard } from '../common/guards/member-jwt.guard';
import { CurrentMember } from '../common/decorators/current-member.decorator';
import { MemberPrincipal } from '../common/guards/member-jwt.guard';

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
}
