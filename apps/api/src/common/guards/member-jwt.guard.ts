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
      headers: { authorization?: string };
      member?: MemberPrincipal;
    }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
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
