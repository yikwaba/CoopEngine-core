import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { CreateMemberDto } from './dto/create-member.dto';

export type MemberStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'EXITED';

export interface MemberRow {
  id: string;
  memberNo: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  gender: string | null;
  status: MemberStatus;
  joinedAt: Date | null;
  createdAt: Date;
}

export interface NextOfKinRow {
  id: string;
  memberId: string;
  fullName: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

/** Allowed transitions per PRD §10-style member lifecycle (FR-006). */
const TRANSITIONS: Record<MemberStatus, MemberStatus[]> = {
  PENDING: ['ACTIVE', 'EXITED'],
  ACTIVE: ['SUSPENDED', 'EXITED'],
  SUSPENDED: ['ACTIVE', 'EXITED'],
  EXITED: [],
};

const selectMember = `SELECT id, member_no, first_name, last_name, email, phone,
       gender, date_of_birth, status, joined_at, created_at
  FROM members`;

@Injectable()
export class MembersService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Org context is mandatory for all member operations. */
  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  async create(
    organizationId: string | null,
    actorUserId: string,
    dto: CreateMemberDto,
  ): Promise<MemberRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      // Allocate member_no from the per-org counter (row lock serializes).
      await c.query(
        `INSERT INTO org_counters (organization_id) VALUES ($1)
         ON CONFLICT (organization_id) DO NOTHING`,
        [orgId],
      );
      const counter = await c.query(
        `UPDATE org_counters SET member_seq = member_seq + 1, updated_at = now()
          WHERE organization_id = $1
          RETURNING member_seq`,
        [orgId],
      );
      const memberNo = Number(
        (counter.rows[0] as { member_seq: string | number }).member_seq,
      );
      const inserted = await c.query(
        `INSERT INTO members (organization_id, member_no, first_name, last_name,
                              email, phone, gender, date_of_birth, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
         RETURNING id, member_no, first_name, last_name, email, phone, gender,
                   status, joined_at, created_at`,
        [
          orgId,
          memberNo,
          dto.firstName,
          dto.lastName,
          dto.email?.toLowerCase() ?? null,
          dto.phone ?? null,
          dto.gender ?? null,
          dto.dateOfBirth ?? null,
          actorUserId,
        ],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'member.created', 'member', $3, $4)`,
        [orgId, actorUserId, (inserted.rows[0] as { id: string }).id, JSON.stringify({ memberNo })],
      );
      return this.toMemberRow(inserted.rows[0] as Record<string, unknown>);
    });
  }

  async list(organizationId: string | null): Promise<MemberRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `${selectMember} WHERE organization_id = $1 ORDER BY member_no`,
        [orgId],
      );
      return rows.map((r) => this.toMemberRow(r as Record<string, unknown>));
    });
  }

  async get(
    organizationId: string | null,
    memberId: string,
  ): Promise<MemberRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `${selectMember} WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      if (!rows[0]) throw new NotFoundException('Member not found');
      return this.toMemberRow(rows[0] as Record<string, unknown>);
    });
  }

  async listNextOfKin(
    organizationId: string | null,
    memberId: string,
  ): Promise<NextOfKinRow[]> {
    const orgId = this.requireOrg(organizationId);
    // Ensure the member exists in this tenant first (RLS-guarded read).
    await this.get(orgId, memberId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, member_id, full_name, relationship, phone, email, address
           FROM next_of_kin WHERE organization_id = $1 AND member_id = $2`,
        [orgId, memberId],
      );
      return rows as NextOfKinRow[];
    });
  }

  async transition(
    organizationId: string | null,
    actorUserId: string,
    memberId: string,
    target: MemberStatus,
  ): Promise<MemberRow> {
    const orgId = this.requireOrg(organizationId);
    if (target === 'PENDING') {
      throw new BadRequestException('Cannot transition back to PENDING');
    }
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      const current = rows[0] as { id: string; status: MemberStatus } | undefined;
      if (!current) throw new NotFoundException('Member not found');
      if (!TRANSITIONS[current.status]?.includes(target)) {
        throw new ConflictException(
          `Invalid transition ${current.status} -> ${target}`,
        );
      }
      const updated = await c.query(
        `UPDATE members
            SET status = $1,
                joined_at = CASE WHEN $1 = 'ACTIVE' AND joined_at IS NULL THEN now() ELSE joined_at END,
                updated_at = now()
          WHERE organization_id = $2 AND id = $3
          RETURNING id, member_no, first_name, last_name, email, phone, gender,
                    status, joined_at, created_at`,
        [target, orgId, memberId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, 'member', $4, $5)`,
        [
          orgId,
          actorUserId,
          `member.status.${target.toLowerCase()}`,
          memberId,
          JSON.stringify({ from: current.status, to: target }),
        ],
      );
      return this.toMemberRow(updated.rows[0] as Record<string, unknown>);
    });
  }

  private toMemberRow(row: Record<string, unknown>): MemberRow {
    return {
      id: row.id as string,
      memberNo: Number(row.member_no),
      firstName: row.first_name as string,
      lastName: row.last_name as string,
      email: (row.email as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      gender: (row.gender as string | null) ?? null,
      status: row.status as MemberStatus,
      joinedAt: (row.joined_at as Date | null) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
