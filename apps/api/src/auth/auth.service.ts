import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { withTenant } from '@coopengine/db';
import * as bcrypt from 'bcryptjs';
import { DB_POOL } from '../database/database.module';
import { ENV } from '../config/env';
import { JwtClaims } from '../common/auth.types';
import { MfaFlowService, MfaProof } from './mfa-flow.service';
import { PRIVILEGED_ROLES, requiresPrivilegedMfa } from './mfa-policy';

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
  authVersion: number;
}

export type LoginProof = MfaProof;

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
  family_id: string;
  mfa_verified: boolean;
}

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

class MfaEnrollmentRequiredException extends ForbiddenException {
  constructor(readonly userId: string, readonly organizationId: string) {
    super('This cooperative requires two-factor authentication for staff. Set up your authenticator app to continue.');
  }
}


@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
    private readonly mfaFlow: MfaFlowService,
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
      `SELECT id, email, password_hash, status, mfa_enabled, auth_version
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
          auth_version: number;
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
      authVersion: user.auth_version,
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
    ipAddress: string | undefined,
    userAgent: string | undefined,
    proof: LoginProof,
  ): Promise<{
    tokens?: SessionTokens;
    requiresOrgSelection: boolean;
    organizations: OrgSummary[];
    recoveryCodes?: string[];
  }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Reset locks the same user. A credential check/challenge from before
      // reset cannot create a session after the new password commits.
      const account = await client.query("SELECT auth_version,mfa_enabled FROM users WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [userId]);
      const user = account.rows[0];
      if (!user || user.auth_version !== proof.authVersion || user.mfa_enabled !== (proof.purpose === 'ENROLL' ? false : proof.mfaVerified)) {
        throw new UnauthorizedException('Sign-in state changed. Please sign in again.');
      }
      const organizations = await this.listOrganizations(userId, client);
      let tokens: SessionTokens | undefined;
      let recoveryCodes: string[] | undefined;
      if (organizationSlug || organizations.length <= 1) {
        if (proof.mfaVerified) recoveryCodes = await this.mfaFlow.finalize(client, userId, proof);
        tokens = await this.issueTokens(userId, organizationSlug ?? organizations[0]?.slug, ipAddress, userAgent, client, undefined, proof.mfaVerified);
      }
      if (tokens && proof.mfaVerified) {
        await client.query(`INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
          VALUES ($1,'auth.mfa.verified','user',$1,'{}'::jsonb)`, [userId]);
      }
      await client.query('COMMIT');
      return { tokens, requiresOrgSelection: !tokens, organizations, ...(recoveryCodes ? { recoveryCodes } : {}) };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof MfaEnrollmentRequiredException) {
        await client.query(`INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
          VALUES ($1,'mfa.login_blocked','user',$1,$2)`, [error.userId, JSON.stringify({ organizationId: error.organizationId })]);
      }
      throw error;
    } finally { client.release(); }
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
    client?: PoolClient,
    familyId: string = randomUUID(),
    mfaVerified = false,
  ): Promise<SessionTokens> {
    const account = await (client ?? this.pool).query("SELECT email FROM users WHERE id=$1 AND status='ACTIVE'", [userId]);
    if (!account.rows[0]) throw new UnauthorizedException('Account is not active');
    const rows = await this.membershipRows(userId, client);

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
      const org = await this.findOrgBySlug(orgMembershipIds, organizationSlug, client);
      if (!org) {
        throw new UnauthorizedException('Not a member of that organization');
      }
      // A suspended cooperative cannot be signed into at all — the platform operator's only
      // lever that takes effect immediately, without touching the tenant's data.
      if (org.status === 'SUSPENDED') {
        throw new ForbiddenException(
          'This cooperative account is suspended. Contact the platform operator.',
        );
      }
      organizationId = org.id;
      contextRows = rows.filter((r) => r.organization_id === organizationId);
      // Organisation MFA policy: a cooperative that requires staff MFA refuses sign-in until
      // the user has enrolled, rather than issuing a session and hoping they enrol later.
      await this.assertMfaPolicy(
        organizationId,
        userId,
        [...new Set(contextRows.map((r) => r.role_code))],
        client,
      );
    } else {
      contextRows = rows.filter(
        (r) => r.organization_id === null && r.role_scope === 'saas',
      );
      if (contextRows.length === 0) {
        throw new UnauthorizedException('No platform role for this user');
      }
    }

    if (!mfaVerified && await this.requiresMfa(userId, organizationSlug, client)) {
      throw new ForbiddenException('Two-step verification is required. Sign in again to enroll or verify.');
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
    const inserted = await (client ?? this.pool).query(
      `INSERT INTO sessions (user_id, organization_id, refresh_token_hash, expires_at, ip_address, user_agent, family_id, mfa_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        organizationId,
        hashToken(refreshToken),
        expiresAt,
        ipAddress ?? null,
        userAgent ?? null,
        familyId,
        mfaVerified,
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
      expiresInSeconds: ENV.jwtAccessTtlSeconds,
      user: { id: userId, email: account.rows[0].email },
      organization: organizationId
        ? await this.fetchOrgSummary(organizationId, client)
        : null,
      permissions,
    };
  }

  // ------------------------------------------------------------------ MFA

  /** A pending secret never replaces an enabled authenticator. */
  async setupMfa(userId: string, _email: string) {
    const version = await this.mfaFlow.assertCanSetup(userId);
    const result = await this.mfaFlow.start(userId, version, 'ENROLL');
    return { ...result.enrollment!, mfaToken: result.mfaToken };
  }
  async verifyMfaSetup(userId: string, code: string): Promise<void> {
    await this.mfaFlow.verifyLatestSetup(userId, code);
  }
  async disableMfa(userId: string, code: string): Promise<void> {
    if (await this.requiresMfa(userId)) throw new ForbiddenException('Two-step verification is required for your account and cannot be disabled.');
    const user = await this.pool.query("SELECT auth_version FROM users WHERE id=$1 AND status='ACTIVE'", [userId]);
    if (!user.rows[0]) throw new UnauthorizedException();
    const challenge = await this.mfaFlow.start(userId, user.rows[0].auth_version, 'LOGIN');
    const { proof } = await this.mfaFlow.verify(challenge.mfaToken, code, 'LOGIN');
    await this.mfaFlow.change(userId, proof, 'disable');
  }
  async requiresMfa(userId: string, slug?: string, client?: PoolClient): Promise<boolean> {
    const rows = await this.membershipRows(userId, client);
    const ids = [...new Set(rows.map(r => r.organization_id))];
    for (const id of ids) {
      const own = rows.filter(r => r.organization_id === id);
      if (slug && (!id || !(await this.findOrgBySlug([id], slug, client)))) continue;
      const roles = own.map(r => r.role_code); const permissions = own.flatMap(r => r.permission_code ? [r.permission_code] : []);
      if (requiresPrivilegedMfa(roles, permissions, false)) return true;
      if (id && requiresPrivilegedMfa(roles, permissions, (await this.orgSecuritySettings(id, client)).mfaRequiredForPrivilegedRoles)) return true;
    }
    return false;
  }

  /**
   * Staff roles bound by the organisation's MFA policy.
   *
   * Members sign in through the member app with a one-time code and do not reach these
   * endpoints, so "privileged" here means every staff role that can open the portal.
   */
  static readonly PRIVILEGED_ROLE_CODES = PRIVILEGED_ROLES;

  /** Security settings a cooperative can turn on for itself. */
  async orgSecuritySettings(
    organizationId: string,
    transaction?: PoolClient,
  ): Promise<{ mfaRequiredForPrivilegedRoles: boolean; requireStepUpForSensitiveMoney: boolean }> {
    const { rows } = await this.authTenant(organizationId, (client) =>
      client.query(
        `SELECT coalesce(settings -> 'security', '{}'::jsonb) AS security
           FROM organization_settings WHERE organization_id = $1`,
        [organizationId],
      ),
      transaction,
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
    client?: PoolClient,
  ): Promise<void> {
    const { mfaRequiredForPrivilegedRoles } = await this.orgSecuritySettings(organizationId, client);
    if (!requiresPrivilegedMfa(roleCodes, [], mfaRequiredForPrivilegedRoles)) return;

    const { rows } = await (client ?? this.pool).query(`SELECT mfa_enabled FROM users WHERE id = $1`, [userId]);
    if ((rows[0] as { mfa_enabled: boolean } | undefined)?.mfa_enabled) return;

    if (!client) await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'mfa.login_blocked', 'user', $1, $2)`,
      [userId, JSON.stringify({ organizationId })],
    );
    // Rotation records the rejection after its transaction rolls back.
    throw new MfaEnrollmentRequiredException(userId, organizationId);
  }

  /** Production cannot opt out; isolated/local tenants can enable the same policy. */
  async assertStepUp(organizationId: string | null, userId: string, code: string | undefined, action: string, sessionId: string): Promise<void> {
    if (!organizationId) throw new ForbiddenException('Select a cooperative before this action.');
    const { requireStepUpForSensitiveMoney } = await this.orgSecuritySettings(organizationId);
    if (process.env.NODE_ENV !== 'production' && !requireStepUpForSensitiveMoney) return;
    if (!code) throw new ForbiddenException({code:'STEP_UP_REQUIRED',message:`Verify with a fresh authenticator code to ${action}.`,action});
    await this.mfaFlow.stepUp(userId,sessionId,organizationId,code,action);
  }

  async createMfaChallenge(userId: string, authVersion: number): Promise<string> {
    return (await this.mfaFlow.start(userId, authVersion, 'LOGIN')).mfaToken;
  }
  async verifyMfaChallenge(mfaToken: string, code: string) {
    return this.mfaFlow.verify(mfaToken, code, 'LOGIN');
  }

  // ------------------------------------------------------------- sessions

  /** Consume once and create the replacement in one transaction. */
  async rotateRefresh(refreshToken: string): Promise<SessionTokens> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lookup = await client.query('SELECT user_id FROM sessions WHERE refresh_token_hash=$1', [hashToken(refreshToken)]);
      if (!lookup.rows[0]) throw new UnauthorizedException('Refresh token invalid or expired');
      // Password reset locks the same user before consuming links/revoking
      // sessions. User-first order prevents a refresh from escaping reset.
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND status='ACTIVE' FOR NO KEY UPDATE", [lookup.rows[0].user_id]);
      if (!user.rows[0]) throw new UnauthorizedException('Account is not active');
      const claimed = await client.query(`UPDATE sessions SET revoked_at=clock_timestamp()
        WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
        RETURNING id,user_id,organization_id,expires_at,revoked_at,family_id,mfa_verified`, [hashToken(refreshToken)]);
      const session = claimed.rows[0] as SessionRow | undefined;
      if (!session) throw new UnauthorizedException('Refresh token invalid or expired');
      const org = session.organization_id ? await this.fetchOrgSummary(session.organization_id, client) : null;
      if (session.organization_id && !org) throw new UnauthorizedException('Organization is unavailable');
      const tokens = await this.issueTokens(session.user_id, org?.slug, undefined, undefined, client, session.family_id, session.mfa_verified);
      await client.query('COMMIT');
      return tokens;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof MfaEnrollmentRequiredException) {
        await client.query(`INSERT INTO audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
          VALUES ($1,'mfa.login_blocked','user',$1,$2)`,
          [error.userId, JSON.stringify({ organizationId: error.organizationId })]);
      }
      throw error;
    } finally { client.release(); }
  }

  async revokeSession(sessionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query('SELECT user_id,family_id FROM sessions WHERE id=$1', [sessionId]);
      if (session.rows[0]) {
        // Serialize with rotation/reset, then revoke all replacements in this
        // browser lineage. Independent logins have different family ids.
        await client.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [session.rows[0].user_id]);
        await client.query(`UPDATE sessions SET revoked_at=clock_timestamp()
          WHERE user_id=$1 AND family_id=$2 AND revoked_at IS NULL`, [session.rows[0].user_id, session.rows[0].family_id]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
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

  private async membershipRows(userId: string, client?: PoolClient): Promise<MembershipRow[]> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT ur.organization_id,
              ro.code AS role_code,
              ro.scope AS role_scope,
              p.code  AS permission_code
         FROM user_roles ur
         JOIN roles ro ON ro.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = ro.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1
          AND (ro.organization_id IS NULL OR ro.organization_id=ur.organization_id)
          AND ro.scope=CASE WHEN ur.organization_id IS NULL THEN 'saas' ELSE 'org' END`,
      [userId],
    );
    return rows as MembershipRow[];
  }

  async listOrganizations(userId: string, client?: PoolClient): Promise<OrgSummary[]> {
    const rows = await this.membershipRows(userId, client);
    const orgIds = [
      ...new Set(
        rows
          .map((r) => r.organization_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const summaries: OrgSummary[] = [];
    for (const orgId of orgIds) {
      const org = await this.fetchOrgSummary(orgId, client);
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
  private async fetchOrgSummary(orgId: string, client?: PoolClient): Promise<OrgSummary | null> {
    return this.authTenant(orgId, async (c) => {
      const res = await c.query(
        `SELECT id, name, slug FROM organizations WHERE id = $1`,
        [orgId],
      );
      return (res.rows[0] as OrgSummary | undefined) ?? null;
    }, client);
  }

  private async findOrgBySlug(
    orgIds: string[],
    slug: string,
    client?: PoolClient,
  ): Promise<{ id: string; name: string; slug: string; status: string } | null> {
    for (const orgId of orgIds) {
      const org = await this.authTenant(orgId, async (c) => {
        const res = await c.query(
          `SELECT id, name, slug, status FROM organizations WHERE id = $1 AND slug = $2`,
          [orgId, slug],
        );
        return res.rows[0] as
          | { id: string; name: string; slug: string; status: string }
          | undefined;
      }, client);
      if (org) return org;
    }
    return null;
  }

  /** Reuse the refresh transaction for tenant reads; do not nest BEGINs or
   * borrow another connection while user locks are held. Restore its context. */
  private async authTenant<T>(orgId: string, work: (client: PoolClient) => Promise<T>, client?: PoolClient): Promise<T> {
    if (!client) return withTenant(this.pool, orgId, work);
    const previous = await client.query("SELECT current_setting('app.tenant_id',true) AS tenant");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [orgId]);
    const result = await work(client);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [previous.rows[0].tenant ?? '']);
    return result;
  }

  private async signAccessToken(claims: JwtClaims): Promise<string> {
    return this.jwtService.signAsync(claims, {
      secret: ENV.jwtAccessSecret,
      expiresIn: ENV.jwtAccessTtlSeconds,
    });
  }
}
