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
import { readAccessCookie } from '../auth-cookies';
import { withTenant } from '@coopengine/db';
import { isPrivilegedStaff, requiresPrivilegedMfa } from '../../auth/mfa-policy';

/**
 * Verifies the Bearer access token and confirms the underlying session is
 * still active (not revoked) — logout/revocation takes effect immediately.
 * Permissions are resolved from current database grants, never the JWT snapshot.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return this.authenticateSession(context);
  }

  protected async authenticateSession(context: ExecutionContext, logoutOnly = false): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    // A browser presents the session cookie; anything else presents a bearer token.
    const header: string | undefined = request.headers?.authorization;
    const cookieToken = readAccessCookie(request);
    const token = cookieToken ?? (header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null);
    if (!token) {
      throw new UnauthorizedException('Missing session');
    }
    let claims: JwtClaims;
    try {
      claims = await this.jwtService.verifyAsync<JwtClaims>(token, {
        secret: ENV.jwtAccessSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { rows } = await this.pool.query(
      `SELECT s.id,s.user_id,s.organization_id,s.revoked_at,s.mfa_verified,u.mfa_enabled,
          grants.memberships,grants.permissions,grants.roles
         FROM sessions s JOIN users u ON u.id=s.user_id
         CROSS JOIN LATERAL (
           SELECT count(DISTINCT ur.id)::int AS memberships,
             COALESCE(array_agg(DISTINCT r.code),ARRAY[]::varchar[]) AS roles,
             COALESCE(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), ARRAY[]::varchar[]) AS permissions
           FROM user_roles ur JOIN roles r ON r.id=ur.role_id
           LEFT JOIN role_permissions rp ON rp.role_id=r.id
           LEFT JOIN permissions p ON p.id=rp.permission_id
           WHERE ur.user_id=s.user_id AND ur.organization_id IS NOT DISTINCT FROM s.organization_id
             AND (r.organization_id IS NULL OR r.organization_id=s.organization_id)
             AND r.scope=CASE WHEN s.organization_id IS NULL THEN 'saas' ELSE 'org' END
         ) grants
        WHERE s.id=$1 AND s.expires_at>clock_timestamp() AND u.status='ACTIVE'`,
      [claims.sid],
    );
    const session = rows[0] as
      | { id: string; user_id: string; organization_id: string | null; revoked_at: Date | null; memberships: number; permissions: string[]; roles: string[]; mfa_enabled: boolean; mfa_verified: boolean }
      | undefined;
    if (
      !session ||
      (!logoutOnly && (session.revoked_at || session.memberships === 0)) ||
      session.user_id !== claims.sub || session.organization_id !== claims.org
    ) {
      throw new UnauthorizedException('Session revoked or not found');
    }
    if (!logoutOnly && !(session.mfa_verified && session.mfa_enabled) && isPrivilegedStaff(session.roles ?? [], session.permissions)) {
      let required = requiresPrivilegedMfa(session.roles ?? [], session.permissions, false);
      if (!required && session.organization_id) {
        const tenantRequired = await withTenant(this.pool, session.organization_id, async c => {
          const settings = await c.query("SELECT settings->'security'->>'mfaRequiredForPrivilegedRoles' AS required FROM organization_settings WHERE organization_id=$1", [session.organization_id]);
          return settings.rows[0]?.required === 'true';
        });
        required = requiresPrivilegedMfa(session.roles ?? [], session.permissions, tenantRequired);
      }
      if (required) throw new UnauthorizedException('Two-step verification is required. Sign in again.');
    }

    const principal: AuthPrincipal = {
      userId: claims.sub,
      sessionId: claims.sid,
      organizationId: session.organization_id,
      permissions: logoutOnly ? [] : session.permissions,
    };
    request.user = principal;
    return true;
  }
}
