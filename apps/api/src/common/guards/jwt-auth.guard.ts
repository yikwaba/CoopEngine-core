import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { ENV } from '../../config/env';
import { JwtClaims, AuthPrincipal } from '../auth.types';

/**
 * Verifies the Bearer access token and confirms the underlying session is
 * still active (not revoked) — logout/revocation takes effect immediately.
 * The session lookup is a single indexed PK read; a Redis cache can replace
 * it later without changing the interface.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    let claims: JwtClaims;
    try {
      claims = await this.jwtService.verifyAsync<JwtClaims>(token, {
        secret: ENV.jwtAccessSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { rows } = await this.pool.query(
      `SELECT id, user_id, revoked_at FROM sessions WHERE id = $1`,
      [claims.sid],
    );
    const session = rows[0] as
      | { id: string; user_id: string; revoked_at: Date | null }
      | undefined;
    if (
      !session ||
      session.revoked_at ||
      session.user_id !== claims.sub
    ) {
      throw new UnauthorizedException('Session revoked or not found');
    }

    const principal: AuthPrincipal = {
      userId: claims.sub,
      sessionId: claims.sid,
      organizationId: claims.org,
      permissions: claims.perms ?? [],
    };
    request.user = principal;
    return true;
  }
}
