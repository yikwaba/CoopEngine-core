import {
  Injectable,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import * as bcrypt from 'bcryptjs';
import { DB_POOL } from '../database/database.module';
import { ENV } from '../config/env';
import { JwtClaims } from '../common/auth.types';

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  roleCodes: string[];
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: { id: string; email: string };
  organization: { id: string; slug: string; name: string } | null;
  permissions: string[];
}

interface MembershipRow {
  organization_id: string | null;
  role_code: string;
  role_scope: string;
  permission_code: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
  ) {}

  // ---------------------------------------------------------------- login

  /** Verify credentials; returns the user and their org summaries. */
  async authenticate(
    email: string,
    password: string,
  ): Promise<{ user: { id: string; email: string }; organizations: OrgSummary[] }> {
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash, status FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    const user = rows[0] as
      | { id: string; email: string; password_hash: string | null; status: string }
      | undefined;
    if (!user || !user.password_hash || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid email or password');
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const organizations = await this.listOrganizations(user.id);
    return { user: { id: user.id, email: user.email }, organizations };
  }

  /**
   * Issue tokens for a context:
   * - organizationSlug provided -> org membership (resolved through the user's
   *   own memberships only — never from arbitrary input)
   * - omitted                    -> platform (saas) context
   */
  async issueTokens(
    userId: string,
    organizationSlug: string | undefined,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<SessionTokens> {
    const rows = await this.membershipRows(userId);

    let organizationId: string | null = null;
    let contextRows: MembershipRow[];

    if (organizationSlug) {
      const orgMembershipIds = [
        ...new Set(
          rows
            .map((r) => r.organization_id)
            .filter((id): id is string => id !== null),
        ),
      ];
      const org = await this.findOrgBySlug(orgMembershipIds, organizationSlug);
      if (!org) {
        throw new UnauthorizedException('Not a member of that organization');
      }
      organizationId = org.id;
      contextRows = rows.filter((r) => r.organization_id === organizationId);
    } else {
      contextRows = rows.filter(
        (r) => r.organization_id === null && r.role_scope === 'saas',
      );
      if (contextRows.length === 0) {
        throw new UnauthorizedException('No platform role for this user');
      }
    }

    const permissions = [
      ...new Set(
        contextRows
          .map((r) => r.permission_code)
          .filter((code): code is string => code !== null),
      ),
    ];

    const refreshToken = randomBytes(48).toString('hex');
    const expiresAt = new Date(
      Date.now() + ENV.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );
    const inserted = await this.pool.query(
      `INSERT INTO sessions (user_id, organization_id, refresh_token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        userId,
        organizationId,
        hashToken(refreshToken),
        expiresAt,
        ipAddress ?? null,
        userAgent ?? null,
      ],
    );
    const sessionId = (inserted.rows[0] as { id: string }).id;

    const accessToken = await this.signAccessToken({
      sub: userId,
      sid: sessionId,
      org: organizationId,
      perms: permissions,
    });

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: 15 * 60,
      user: { id: userId, email: await this.emailFor(userId) },
      organization: organizationId
        ? await this.fetchOrgSummary(organizationId)
        : null,
      permissions,
    };
  }

  // ------------------------------------------------------------- sessions

  /** Rotate a refresh token: revoke old session, issue a new one. */
  async rotateRefresh(refreshToken: string): Promise<SessionTokens> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, organization_id, expires_at, revoked_at
         FROM sessions WHERE refresh_token_hash = $1`,
      [hashToken(refreshToken)],
    );
    const session = rows[0] as SessionRow | undefined;
    if (
      !session ||
      session.revoked_at ||
      new Date(session.expires_at).getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Refresh token invalid or expired');
    }

    // Rotate: revoke this session, then issue a fresh one for the same context.
    await this.revokeSession(session.id);
    const orgSlug = session.organization_id
      ? (await this.fetchOrgSummary(session.organization_id))?.slug
      : undefined;
    return this.issueTokens(session.user_id, orgSlug);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  // ---------------------------------------------------------------- misc

  async findUserById(
    userId: string,
  ): Promise<{ id: string; email: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, email FROM users WHERE id = $1`,
      [userId],
    );
    return (rows[0] as { id: string; email: string } | undefined) ?? null;
  }

  async recordAudit(
    organizationId: string | null,
    actorUserId: string | null,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        organizationId,
        actorUserId,
        action,
        entityType,
        entityId,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  // ------------------------------------------------------------- helpers

  private async membershipRows(userId: string): Promise<MembershipRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ur.organization_id,
              ro.code AS role_code,
              ro.scope AS role_scope,
              p.code  AS permission_code
         FROM user_roles ur
         JOIN roles ro ON ro.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = ro.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [userId],
    );
    return rows as MembershipRow[];
  }

  private async listOrganizations(userId: string): Promise<OrgSummary[]> {
    const rows = await this.membershipRows(userId);
    const orgIds = [
      ...new Set(
        rows
          .map((r) => r.organization_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const summaries: OrgSummary[] = [];
    for (const orgId of orgIds) {
      const org = await this.fetchOrgSummary(orgId);
      if (org) {
        summaries.push({
          id: org.id,
          slug: org.slug,
          name: org.name,
          roleCodes: rows
            .filter((r) => r.organization_id === orgId)
            .map((r) => r.role_code),
        });
      }
    }
    return summaries;
  }

  /** RLS-safe org read: each org is read inside its own tenant transaction. */
  private async fetchOrgSummary(
    orgId: string,
  ): Promise<OrgSummary | null> {
    return withTenant(this.pool, orgId, async (c) => {
      const res = await c.query(
        `SELECT id, name, slug FROM organizations WHERE id = $1`,
        [orgId],
      );
      return (res.rows[0] as OrgSummary | undefined) ?? null;
    });
  }

  private async findOrgBySlug(
    orgIds: string[],
    slug: string,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    for (const orgId of orgIds) {
      const org = await withTenant(this.pool, orgId, async (c) => {
        const res = await c.query(
          `SELECT id, name, slug FROM organizations WHERE id = $1 AND slug = $2`,
          [orgId, slug],
        );
        return res.rows[0] as
          | { id: string; name: string; slug: string }
          | undefined;
      });
      if (org) return org;
    }
    return null;
  }

  private async emailFor(userId: string): Promise<string> {
    const user = await this.findUserById(userId);
    return user?.email ?? '';
  }

  private async signAccessToken(claims: JwtClaims): Promise<string> {
    return this.jwtService.signAsync(claims, {
      secret: ENV.jwtAccessSecret,
      expiresIn: ENV.jwtAccessTtlSeconds,
    });
  }
}
