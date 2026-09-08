import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { MemberPrincipal } from '../guards/member-jwt.guard';

/** Injects the authenticated member principal (see MemberJwtGuard). */
export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MemberPrincipal => {
    const request = ctx.switchToHttp().getRequest<{ member?: MemberPrincipal }>();
    return request.member as MemberPrincipal;
  },
);
