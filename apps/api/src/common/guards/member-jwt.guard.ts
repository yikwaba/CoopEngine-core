import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ENV } from '../../config/env';
import { MemberClaims } from '../../member-auth/member-auth.service';
import { readAccessCookie } from '../auth-cookies';

/** Authenticated member principal attached by MemberJwtGuard. */
export interface MemberPrincipal {
  memberId: string;
  organizationId: string;
  memberNo: string;
}

@Injectable()
export class MemberJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string; cookie?: string };
      member?: MemberPrincipal;
    }>();
    // The member app is a browser: its session arrives as a cookie. A bearer token still works.
    const header = request.headers.authorization;
    const cookieToken = readAccessCookie(request as unknown as Parameters<typeof readAccessCookie>[0]);
    const token =
      cookieToken ?? (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null);
    if (!token) {
      throw new UnauthorizedException('Missing session');
    }
    let claims: MemberClaims;
    try {
      claims = await this.jwtService.verifyAsync<MemberClaims>(token, {
        secret: ENV.jwtAccessSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (claims.typ !== 'member') {
      throw new ForbiddenException('This endpoint is for members only');
    }
    request.member = {
      memberId: claims.sub,
      organizationId: claims.org,
      memberNo: claims.mid,
    };
    return true;
  }
}
