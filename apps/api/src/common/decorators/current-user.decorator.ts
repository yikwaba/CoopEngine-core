import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthPrincipal } from '../auth.types';

/** Injects the authenticated principal (see JwtAuthGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthPrincipal;
  },
);
