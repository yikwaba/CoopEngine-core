import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash, randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { ENV } from '../config/env';
import { DB_POOL } from '../database/database.module';

export interface MemberClaims {
  typ: 'member';
  sub: string; // member id
  org: string; // organization id
  mid: string; // member no (for convenience)
}

export interface MemberSession {
  accessToken: string;
  member: {
    id: string;
    memberNo: number;
    firstName: string;
    lastName: string;
    email: string | null;
  };
}

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const DEV_PROVIDER = (process.env.MEMBER_OTP_PROVIDER ?? 'dev').toLowerCase() === 'dev';

const hashCode = (code: string): string =>
  createHash('sha256').update(`coopengine-otp:${code}`).digest('hex');

@Injectable()
export class MemberAuthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jwtService: JwtService,
  ) {}

  /** Resolve an org id from its public slug (context-free resolver table). */
  private async resolveOrgBySlug(slug: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT organization_id FROM org_lookups WHERE slug = $1`,
      [slug.trim().toLowerCase()],
    );
    return (rows[0] as { organization_id: string } | undefined)?.organization_id ?? null;
  }

  /**
   * Request an OTP for a member. Returns a development-only `devCode` when
   * the DEV provider is active (production routes to Termii/WhatsApp and
   * never returns the code). Always 200-shaped to avoid member enumeration.
   */
  async requestOtp(
    organizationSlug: string,
    email: string,
  ): Promise<{ sent: boolean; devCode?: string; provider: string }> {
    const provider: 'dev' | 'termii' =
      (process.env.MEMBER_OTP_PROVIDER ?? 'dev').toLowerCase() === 'termii'
        ? 'termii'
        : 'dev';
    const orgId = await this.resolveOrgBySlug(organizationSlug);
    if (!orgId) {
      return { sent: false, provider };
    }
    let devCode: string | undefined;
    let phone: string | null = null;
    let codeOut: string | undefined;
    await withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, status, phone FROM members
          WHERE organization_id = $1 AND lower(email) = lower($2)`,
        [orgId, email],
      );
      const m = member.rows[0] as
        | { id: string; status: string; phone: string | null }
        | undefined;
      if (!m || m.status !== 'ACTIVE') {
        return; // generic response; no OTP stored
      }
      if (provider === 'termii' && !m.phone) {
        return; // no delivery channel for this member
      }
      // Invalidate prior unused codes for this member
      await c.query(
        `UPDATE member_otps SET used_at = now()
          WHERE organization_id = $1 AND member_id = $2 AND used_at IS NULL`,
        [orgId, m.id],
      );
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expires = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);
      await c.query(
        `INSERT INTO member_otps (organization_id, member_id, code_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [orgId, m.id, hashCode(code), expires],
      );
      if (provider === 'dev') {
        devCode = code;
      } else {
        phone = m.phone;
        codeOut = code;
      }
    });
    if (provider === 'termii' && codeOut && phone) {
      const delivered = await this.termiiDeliver(phone, codeOut);
      return { sent: delivered, provider };
    }
    return {
      sent: devCode !== undefined,
      devCode,
      provider,
    };
  }

  /**
   * Deliver the 6-digit code by SMS through Termii (generic channel).
   * Requires TERMII_API_KEY + TERMII_SENDER_ID. Failures are logged and
   * reported as not-sent — the caller keeps the response generic.
   */
  private async termiiDeliver(to: string, code: string): Promise<boolean> {
    const apiKey = process.env.TERMII_API_KEY;
    const senderId = process.env.TERMII_SENDER_ID;
    if (!apiKey || !senderId) {
      // eslint-disable-next-line no-console
      console.error('MEMBER_OTP_PROVIDER=termii but TERMII_API_KEY/TERMII_SENDER_ID missing');
      return false;
    }
    try {
      const res = await fetch('https://api.ng.termii.com/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          to,
          from: senderId,
          type: 'plain',
          channel: 'generic',
          message: `Your Co-opEngine verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes. Do not share it.`,
        }),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(`Termii send failed: ${res.status} ${await res.text()}`);
        return false;
      }
      const body = (await res.json()) as { message_id?: string };
      return body.message_id !== undefined;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Termii send error:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Verify an OTP and issue a member-scoped access token (60 min). */
  async verifyOtp(
    organizationSlug: string,
    email: string,
    code: string,
  ): Promise<MemberSession> {
    const orgId = await this.resolveOrgBySlug(organizationSlug);
    if (!orgId) throw new UnauthorizedException('Invalid or expired code');
    if (!/^\d{6}$/.test(code)) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    const session = await withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, member_no, first_name, last_name, email, status FROM members
          WHERE organization_id = $1 AND lower(email) = lower($2)`,
        [orgId, email],
      );
      const m = member.rows[0] as
        | { id: string; member_no: number; first_name: string; last_name: string; email: string | null; status: string }
        | undefined;
      if (!m || m.status !== 'ACTIVE') {
        throw new UnauthorizedException('Invalid or expired code');
      }
      const otp = await c.query(
        `SELECT id, code_hash, expires_at, used_at, attempts FROM member_otps
          WHERE organization_id = $1 AND member_id = $2 AND used_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [orgId, m.id],
      );
      const row = otp.rows[0] as
        | { id: string; code_hash: string; expires_at: Date; used_at: Date | null; attempts: string }
        | undefined;
      if (!row || new Date(row.expires_at).getTime() < Date.now()) {
        throw new UnauthorizedException('Invalid or expired code');
      }
      if (Number(row.attempts) >= MAX_ATTEMPTS) {
        throw new UnauthorizedException('Too many attempts — request a new code');
      }
      if (row.code_hash !== hashCode(code)) {
        await c.query(
          `UPDATE member_otps SET attempts = attempts + 1
            WHERE organization_id = $1 AND id = $2`,
          [orgId, row.id],
        );
        throw new UnauthorizedException('Invalid or expired code');
      }
      await c.query(
        `UPDATE member_otps SET used_at = now()
          WHERE organization_id = $1 AND id = $2`,
        [orgId, row.id],
      );
      return { member: m, orgId };
    });

    const claims: MemberClaims = {
      typ: 'member',
      sub: session.member.id,
      org: orgId,
      mid: String(session.member.member_no),
    };
    const accessToken = await this.jwtService.signAsync(claims, {
      secret: ENV.jwtAccessSecret,
      expiresIn: 3600,
    });
    return {
      accessToken,
      member: {
        id: session.member.id,
        memberNo: Number(session.member.member_no),
        firstName: session.member.first_name,
        lastName: session.member.last_name,
        email: session.member.email,
      },
    };
  }
}
