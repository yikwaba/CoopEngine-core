import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

export interface OrgUserRow {
  id: string;
  email: string;
  status: string;
  roleCodes: string[];
  createdAt: Date;
}

const ROUNDS = 12;

@Injectable()
export class OrgUsersService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  private async loadRoles(
    orgId: string,
    roleCodes: string[],
  ): Promise<{ id: string; code: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, code FROM roles
        WHERE code = ANY($1::varchar[])
          AND scope = 'org'
          AND (organization_id IS NULL OR organization_id = $2)`,
      [roleCodes, orgId],
    );
    return rows as { id: string; code: string }[];
  }

  async list(organizationId: string | null): Promise<OrgUserRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT u.id, u.email, u.status, u.created_at,
                COALESCE(
                  (SELECT json_agg(r.code ORDER BY r.code)
                     FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND ur.organization_id = $1),
                  '[]'::json
                ) AS role_codes
           FROM users u
           JOIN user_roles our ON our.user_id = u.id AND our.organization_id = $1
          GROUP BY u.id
          ORDER BY u.created_at DESC`,
        [orgId],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        email: r.email as string,
        status: r.status as string,
        roleCodes: (r.role_codes as string[]) ?? [],
        createdAt: r.created_at as Date,
      }));
    });
  }

  /** Invite a staff user with a temp password; roles are org templates. */
  async invite(
    organizationId: string | null,
    actorUserId: string,
    email: string,
    roleCodes: string[],
  ): Promise<OrgUserRow & { tempPassword: string }> {
    const orgId = this.requireOrg(organizationId);
    const normalized = email.trim().toLowerCase();
    const codes = [...new Set(roleCodes)];
    if (codes.length === 0) {
      throw new ConflictException('At least one role is required');
    }
    const roles = await this.loadRoles(orgId, codes);
    const found = new Set(roles.map((r) => r.code));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length > 0) {
      throw new NotFoundException(`Unknown role code(s): ${missing.join(', ')}`);
    }
    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(tempPassword, ROUNDS);
    await withTenant(this.pool, orgId, async (c) => {
      const exists = await c.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [normalized]);
      if (exists.rows[0]) {
        throw new ConflictException('A user with that email already exists');
      }
      const ins = await c.query(
        `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id, email, status, created_at`,
        [normalized, passwordHash],
      );
      const userId = (ins.rows[0] as { id: string }).id;
      for (const role of roles) {
        await c.query(
          `INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)`,
          [orgId, userId, role.id],
        );
      }
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'users.invited', 'user', $3, $4)`,
        [
          orgId,
          actorUserId,
          userId,
          JSON.stringify({ email: normalized, roleCodes: codes }),
        ],
      );
    });
    const row = await this.getUser(orgId, normalized);
    return { ...row, tempPassword };
  }

  private async getUser(orgId: string, email: string): Promise<OrgUserRow> {
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT u.id, u.email, u.status, u.created_at,
                COALESCE(
                  (SELECT json_agg(r.code ORDER BY r.code)
                     FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND ur.organization_id = $1),
                  '[]'::json
                ) AS role_codes
           FROM users u
          WHERE lower(u.email) = lower($2)`,
        [orgId, email],
      );
      if (!rows[0]) throw new NotFoundException('User not found in this organization');
      const r = rows[0] as Record<string, unknown>;
      return {
        id: r.id as string,
        email: r.email as string,
        status: r.status as string,
        roleCodes: (r.role_codes as string[]) ?? [],
        createdAt: r.created_at as Date,
      };
    });
  }

  private async userIdByEmail(orgId: string, email: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT u.id FROM users u
        JOIN user_roles ur ON ur.user_id = u.id AND ur.organization_id = $1
       WHERE lower(u.email) = lower($2) LIMIT 1`,
      [orgId, email],
    );
    if (!rows[0]) throw new NotFoundException('User not found in this organization');
    return (rows[0] as { id: string }).id;
  }

  /** Count of org members (excluding `excludeUserId`) holding a permission. */
  private async countWithPermission(
    orgId: string,
    permission: string,
    excludeUserId?: string,
  ): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(DISTINCT ur.user_id)::int AS n
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.organization_id = $1 AND p.code = $2
          AND ($3::uuid IS NULL OR ur.user_id <> $3::uuid)`,
      [orgId, permission, excludeUserId ?? null],
    );
    return (rows[0] as { n: number }).n;
  }

  /** Replace the org roles of a staff user (keeps at least one users.manage holder). */
  async replaceRoles(
    organizationId: string | null,
    actorUserId: string,
    email: string,
    roleCodes: string[],
  ): Promise<OrgUserRow> {
    const orgId = this.requireOrg(organizationId);
    const codes = [...new Set(roleCodes)];
    if (codes.length === 0) {
      throw new ConflictException('At least one role is required');
    }
    const targetId = await this.userIdByEmail(orgId, email);
    if (targetId === actorUserId) {
      throw new ConflictException('You cannot change your own roles');
    }
    const roles = await this.loadRoles(orgId, codes);
    const found = new Set(roles.map((r) => r.code));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length > 0) {
      throw new NotFoundException(`Unknown role code(s): ${missing.join(', ')}`);
    }
    const targetRoles = (await this.getUser(orgId, email)).roleCodes;
    const targetIsAdmin = targetRoles.includes('COOP_ADMIN');
    const othersManage = await this.countWithPermission(orgId, 'users.manage', targetId);
    if (targetIsAdmin && !codes.includes('COOP_ADMIN') && othersManage === 0) {
      throw new ConflictException('At least one COOP_ADMIN must remain');
    }
    await withTenant(this.pool, orgId, async (c) => {
      await c.query(
        `DELETE FROM user_roles WHERE organization_id = $1 AND user_id = $2`,
        [orgId, targetId],
      );
      for (const role of roles) {
        await c.query(
          `INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)`,
          [orgId, targetId, role.id],
        );
      }
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'users.roles_replaced', 'user', $3, $4)`,
        [orgId, actorUserId, targetId, JSON.stringify({ roleCodes: codes })],
      );
    });
    return this.getUser(orgId, email);
  }

  /** Suspend (or reactivate) a staff user; blocks self-suspension. */
  async setStatus(
    organizationId: string | null,
    actorUserId: string,
    email: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<OrgUserRow> {
    const orgId = this.requireOrg(organizationId);
    const targetId = await this.userIdByEmail(orgId, email);
    if (targetId === actorUserId) {
      throw new ConflictException('You cannot change your own status');
    }
    const targetRoles = (await this.getUser(orgId, email)).roleCodes;
    const targetIsAdmin = targetRoles.includes('COOP_ADMIN');
    const othersManage = await this.countWithPermission(orgId, 'users.manage', targetId);
    if (status === 'SUSPENDED' && targetIsAdmin && othersManage === 0) {
      throw new ConflictException('At least one COOP_ADMIN must remain');
    }
    await withTenant(this.pool, orgId, async (c) => {
      await c.query(
        `UPDATE users SET status = $1, updated_at = now() WHERE id = $2`,
        [status, targetId],
      );
      if (status === 'SUSPENDED') {
        await c.query(`DELETE FROM sessions WHERE user_id = $1`, [targetId]);
      }
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, 'user', $4, $5)`,
        [
          orgId,
          actorUserId,
          `users.${status.toLowerCase()}`,
          targetId,
          JSON.stringify({ email }),
        ],
      );
    });
    return this.getUser(orgId, email);
  }
}
