import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import * as bcrypt from 'bcryptjs';
import {
  generateSecret,
  generateURI,
  verify,
} from 'otplib/functional';
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

/** Result of credential verification (before org/context selection). */
export interface AuthenticatedUser {
  id: string;
  email: string;
  mfaEnabled: boolean;
  organizations: OrgSummary[];
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

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const MFA_ISSUER = 'Co-opEngine';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
  ) {}

  // ----------------------------------------------------------- rate limit

  private async assertLoginAllowed(email: string, ip: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE email = $1 AND ip_address = $2
          AND attempted_at > now() - interval '15 minutes'`,
      [email.toLowerCase(), ip],
    );
    if ((rows[0] as { n: number }).n >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many login attempts. Try again in 15 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordLoginFailure(email: string, ip: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO login_attempts (email, ip_address) VALUES ($1, $2)`,
      [email.toLowerCase(), ip],
    );
  }

  private async clearLoginFailures(email: string): Promise<void> {
    await this.pool.query(`DELETE FROM login_attempts WHERE email = $1`, [
      email.toLowerCase(),
    ]);
  }

  // ---------------------------------------------------------------- login

  /** Verify credentials (rate-limited). Does NOT issue tokens yet. */
  async authenticate(
    email: string,
    password: string,
    ipAddress = 'unknown',
  ): Promise<AuthenticatedUser> {
    await this.assertLoginAllowed(email, ipAddress);
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash, status, mfa_enabled
         FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    const user = rows[0] as
      | {
          id: string;
          email: string;
          password_hash: string | null;
          status: string;
          mfa_enabled: boolean;
        }
      | undefined;
    if (!user || !user.password_hash || user.status !== 'ACTIVE') {
      await this.recordLoginFailure(email, ipAddress);
      throw new UnauthorizedException('Invalid email or password');
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await this.recordLoginFailure(email, ipAddress);
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.clearLoginFailures(email);
    const organizations = await this.listOrganizations(user.id);
    return {
      id: user.id,
      email: user.email,
      mfaEnabled: user.mfa_enabled,
      organizations,
    };
  }

  /**
   * Resolve org context and issue tokens:
   * - slug provided -> that org membership
   * - no slug + no orgs -> platform (saas) context
   * - no slug + one org -> auto-select
   * - no slug + many orgs -> requiresOrgSelection
   */
  async issueForUser(
    userId: string,
    organizationSlug: string | undefined,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{
    tokens?: SessionTokens;
    requiresOrgSelection: boolean;
    organizations: OrgSummary[];
  }> {
    const organizations = await this.listOrganizations(userId);

    if (organizations.length === 0 && organizationSlug === undefined) {
      const tokens = await this.issueTokens(
        userId,
        undefined,
        ipAddress,
        userAgent,
      );
      return { tokens, requiresOrgSelection: false, organizations };
    }
    if (organizations.length === 1 && organizationSlug === undefined) {
      const tokens = await this.issueTokens(
        userId,
        organizations[0]?.slug,
        ipAddress,
        userAgent,
      );
      return { tokens, requiresOrgSelection: false, organizations };
    }
    if (organizationSlug) {
      const tokens = await this.issueTokens(
        userId,
        organizationSlug,
        ipAddress,
        userAgent,
      );
      return { tokens, requiresOrgSelection: false, organizations };
    }
    return {
      tokens: undefined,
      requiresOrgSelection: true,
      organizations,
    };
  }

  /**
   * Issue tokens for a context:
   * - organizationSlug provided -> org membership (resolved through the user's
   *   own memberships only — never from arbitrary input)
   * - omitted                    -> platform (saas) context
   */
  private async issueTokens(
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
      // Organisation MFA policy: a cooperative that requires staff MFA refuses sign-in until
      // the user has enrolled, rather than issuing a session and hoping they enrol later.
      await this.assertMfaPolicy(
        organizationId,
        userId,
        [...new Set(contextRows.map((r) => r.role_code))],
      );
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

  // ------------------------------------------------------------------ MFA

  /** Generate a TOTP secret + otpauth URL (persisted, not yet enabled). */
  async setupMfa(userId: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = generateSecret();
    const otpauthUrl = generateURI({
      secret,
      label: email,
      issuer: MFA_ISSUER,
    });
    await this.pool.query(
      `UPDATE users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2`,
      [secret, userId],
    );
    return { secret, otpauthUrl };
  }

  /** Confirm setup with a live TOTP code; enables MFA. */
  async verifyMfaSetup(userId: string, code: string): Promise<void> {
    const secret = await this.rawMfaSecretFor(userId);
    if (!secret || !(await this.verifyCode(secret, code))) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    await this.pool.query(
      `UPDATE users SET mfa_enabled = true WHERE id = $1`,
      [userId],
    );
    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'mfa.enabled', 'user', $1, $2)`,
      [userId, JSON.stringify({ method: 'totp' })],
    );
  }

  /** Disable MFA after verifying the current code. */
  async disableMfa(userId: string, code: string): Promise<void> {
    const secret = await this.mfaSecretFor(userId);
    if (!secret || !(await this.verifyCode(secret, code))) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    await this.pool.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`,
      [userId],
    );
    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'mfa.disabled', 'user', $1, $2)`,
      [userId, JSON.stringify({ method: 'totp' })],
    );
  }

  /**
   * Staff roles bound by the organisation's MFA policy.
   *
   * Members sign in through the member app with a one-time code and do not reach these
   * endpoints, so "privileged" here means every staff role that can open the portal.
   */
  static readonly PRIVILEGED_ROLE_CODES = [
    'COOP_ADMIN',
    'TREASURER',
    'ACCOUNTANT',
    'LOAN_OFFICER',
    'CREDIT_COMMITTEE',
    'AUDITOR',
    'CHAIRMAN',
    'SECRETARY',
  ];

  /** Security settings a cooperative can turn on for itself. */
  async orgSecuritySettings(
    organizationId: string,
  ): Promise<{ mfaRequiredForPrivilegedRoles: boolean; requireStepUpForSensitiveMoney: boolean }> {
    const { rows } = await withTenant(this.pool, organizationId, (client) =>
      client.query(
        `SELECT coalesce(settings -> 'security', '{}'::jsonb) AS security
           FROM organization_settings WHERE organization_id = $1`,
        [organizationId],
      ),
    );
    const security = ((rows[0] as { security?: Record<string, unknown> } | undefined)?.security ?? {}) as Record<
      string,
      unknown
    >;
    return {
      mfaRequiredForPrivilegedRoles: security.mfaRequiredForPrivilegedRoles === true,
      requireStepUpForSensitiveMoney: security.requireStepUpForSensitiveMoney === true,
    };
  }

  /**
   * Refuse a staff sign-in when the cooperative requires MFA and this user has not set it up.
   *
   * Returns nothing when the policy is off, the user is not bound by it, or MFA is already on.
   * The error carries a code so the portal can send the user straight to enrolment instead of
   * showing "forbidden".
   */
  async assertMfaPolicy(
    organizationId: string,
    userId: string,
    roleCodes: string[],
  ): Promise<void> {
    const { mfaRequiredForPrivilegedRoles } = await this.orgSecuritySettings(organizationId);
    if (!mfaRequiredForPrivilegedRoles) return;
    const bound = roleCodes.some((code) => AuthService.PRIVILEGED_ROLE_CODES.includes(code));
    if (!bound) return;

    const { rows } = await this.pool.query(`SELECT mfa_enabled FROM users WHERE id = $1`, [userId]);
    if ((rows[0] as { mfa_enabled: boolean } | undefined)?.mfa_enabled) return;

    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'mfa.login_blocked', 'user', $1, $2)`,
      [userId, JSON.stringify({ organizationId })],
    );
    throw new ForbiddenException(
      'This cooperative requires two-factor authentication for staff. Set up your authenticator app to continue.',
    );
  }

  /**
   * Step-up authentication for actions that move money or rewrite the books.
   *
   * When the cooperative turns this on, the caller must present a live TOTP code with the
   * request. MFA must already be enabled — a policy that can be satisfied by "no MFA set up"
   * would be no policy at all.
   */
  async assertStepUp(
    organizationId: string | null,
    userId: string,
    code: string | undefined,
    action: string,
  ): Promise<void> {
    // No cooperative context means the action has no books to protect; the service layer
    // rejects such calls anyway, so there is nothing to step up to.
    if (!organizationId) return;
    const { requireStepUpForSensitiveMoney } = await this.orgSecuritySettings(organizationId);
    if (!requireStepUpForSensitiveMoney) return;

    const { rows } = await this.pool.query(
      `SELECT mfa_enabled, mfa_secret FROM users WHERE id = $1`,
      [userId],
    );
    const user = rows[0] as { mfa_enabled: boolean; mfa_secret: string | null } | undefined;
    if (!user?.mfa_enabled || !user.mfa_secret) {
      throw new ForbiddenException(
        'This cooperative requires step-up verification for this action, and MFA must be enabled on your account first',
      );
    }
    if (!code) {
      throw new ForbiddenException(`A step-up verification code is required to ${action}`);
    }
    if (!(await this.verifyCode(user.mfa_secret, code))) {
      await this.pool.query(
        `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'stepup.failed', 'user', $1, $2)`,
        [userId, JSON.stringify({ action })],
      );
      throw new UnauthorizedException('Invalid step-up verification code');
    }
    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'stepup.verified', 'user', $1, $2)`,
      [userId, JSON.stringify({ action })],
    );
  }

  /** Short-lived challenge token issued when MFA is enabled at login. */
  async createMfaChallenge(userId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId, typ: 'mfa' },
      { secret: ENV.jwtAccessSecret, expiresIn: 5 * 60 },
    );
  }

  /** Verify challenge token + TOTP code; returns the user id. */
  async verifyMfaChallenge(
    mfaToken: string,
    code: string,
  ): Promise<string> {
    let claims: { sub: string; typ?: string };
    try {
      claims = await this.jwtService.verifyAsync<{ sub: string; typ?: string }>(
        mfaToken,
        { secret: ENV.jwtAccessSecret },
      );
    } catch {
      throw new UnauthorizedException('MFA challenge expired or invalid');
    }
    if (claims.typ !== 'mfa') {
      throw new UnauthorizedException('MFA challenge expired or invalid');
    }
    const userId = claims.sub;
    const secret = await this.mfaSecretFor(userId);
    if (!secret || !(await this.verifyCode(secret, code))) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'auth.mfa.verified', 'user', $1, $2)`,
      [userId, JSON.stringify({})],
    );
    return userId;
  }

  private async mfaSecretFor(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1`,
      [userId],
    );
    const user = rows[0] as
      | { mfa_secret: string | null; mfa_enabled: boolean }
      | undefined;
    if (!user?.mfa_enabled || !user.mfa_secret) return null;
    return user.mfa_secret;
  }

  /** Secret regardless of enabled state (used during setup verification). */
  private async rawMfaSecretFor(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT mfa_secret FROM users WHERE id = $1`,
      [userId],
    );
    const user = rows[0] as { mfa_secret: string | null } | undefined;
    return user?.mfa_secret ?? null;
  }

  /** otplib v13 verify returns {valid}; unwrap to a boolean. */
  private async verifyCode(secret: string, code: string): Promise<boolean> {
    const result = await verify({ secret, token: code });
    return result?.valid === true;
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
  ): Promise<{ id: string; email: string; mfaEnabled: boolean } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, email, mfa_enabled FROM users WHERE id = $1`,
      [userId],
    );
    const u = rows[0] as
      | { id: string; email: string; mfa_enabled: boolean }
      | undefined;
    return u
      ? { id: u.id, email: u.email, mfaEnabled: u.mfa_enabled }
      : null;
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
  private async fetchOrgSummary(orgId: string): Promise<OrgSummary | null> {
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
