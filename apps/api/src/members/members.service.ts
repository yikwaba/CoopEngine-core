import { randomUUID } from 'node:crypto';
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
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

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

  async list(
    organizationId: string | null,
    limit?: number,
    offset?: number,
    q?: string,
  ): Promise<{ items: MemberRow[]; total: number }> {
    const orgId = this.requireOrg(organizationId);
    const pageLimit = Math.min(Math.max(limit ?? 200, 1), 500);
    const pageOffset = Math.max(offset ?? 0, 0);
    const search = q?.trim();
    const clause = (param: number): string =>
      search
        ? `AND (
             first_name ILIKE $${param} OR last_name ILIKE $${param} OR email ILIKE $${param}
             OR member_no::text ILIKE $${param}
           )`
        : '';
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [orgId, pageLimit, pageOffset];
      if (search) params.push(`%${search}%`);
      const { rows } = await c.query(
        `${selectMember} WHERE organization_id = $1 ${clause(4)} ORDER BY member_no LIMIT $2 OFFSET $3`,
        params,
      );
      const count = await c.query(
        `SELECT count(*)::int AS n FROM members WHERE organization_id = $1 ${clause(2)}`,
        search ? [orgId, `%${search}%`] : [orgId],
      );
      return {
        items: rows.map((r) => this.toMemberRow(r as Record<string, unknown>)),
        total: (count.rows[0] as { n: number }).n,
      };
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

  /**
   * Full member exit: blocked while open loans exist; closes savings and
   * share accounts with a single payout journal (Dr 2000 + Dr 3000 /
   * Cr 1000) inside the same tenant transaction.
   */
  async exitMember(
    organizationId: string | null,
    actorUserId: string,
    memberId: string,
  ): Promise<{ member: MemberRow; payout: number; closedAccounts: number }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      const current = member.rows[0] as { id: string; status: MemberStatus } | undefined;
      if (!current) throw new NotFoundException('Member not found');
      if (current.status !== 'ACTIVE' && current.status !== 'SUSPENDED') {
        throw new ConflictException(
          `Only ACTIVE or SUSPENDED members can exit (current: ${current.status})`,
        );
      }
      // Blocked while the member still owes or has undisbursed approvals
      const openLoans = await c.query(
        `SELECT count(*)::int AS n,
                COALESCE(SUM(outstanding_principal), 0)::numeric AS outstanding
           FROM loans
          WHERE organization_id = $1 AND member_id = $2
            AND status IN ('APPROVED', 'DISBURSED', 'DEFAULTED')`,
        [orgId, memberId],
      );
      const open = openLoans.rows[0] as { n: number; outstanding: string };
      if (open.n > 0) {
        throw new ConflictException(
          `Cannot exit: ${open.n} open loan(s) with ₦${open.outstanding} outstanding`,
        );
      }
      // Gather payable balances
      const savings = await c.query(
        `SELECT id, current_balance FROM member_savings_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'
            AND current_balance > 0`,
        [orgId, memberId],
      );
      const shares = await c.query(
        `SELECT id, current_balance FROM member_share_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'
            AND current_balance > 0`,
        [orgId, memberId],
      );
      const savingsRows = savings.rows as { id: string; current_balance: string }[];
      const shareRows = shares.rows as { id: string; current_balance: string }[];
      const totalSavings = round2(
        savingsRows.reduce((a, r) => a + Number(r.current_balance), 0),
      );
      const totalShares = round2(
        shareRows.reduce((a, r) => a + Number(r.current_balance), 0),
      );
      const payout = round2(totalSavings + totalShares);

      if (payout > 0) {
        const period = await c.query(
          `SELECT id FROM ledger_periods
            WHERE organization_id = $1 AND status = 'OPEN'
              AND now()::date BETWEEN start_date AND end_date
            ORDER BY start_date DESC LIMIT 1`,
          [orgId],
        );
        const periodId = (period.rows[0] as { id: string } | undefined)?.id;
        if (!periodId) {
          throw new ConflictException('No OPEN accounting period for today — cannot post');
        }
        const seq = await c.query(
          `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
            WHERE organization_id = $1 RETURNING journal_seq`,
          [orgId],
        );
        const entryNo = Number(
          (seq.rows[0] as { journal_seq: string | number }).journal_seq,
        );
        const entryId = randomUUID();
        await c.query(
          `INSERT INTO journal_entries
             (id, organization_id, period_id, entry_date, description, source,
              source_type, source_id, status, entry_no, created_by, posted_by, posted_at)
           VALUES ($1, $2, $3, now()::date, $4, 'MEMBER_EXIT_PAYOUT', 'member', $5,
                   'POSTED', $6, $7, $7, now())`,
          [
            entryId,
            orgId,
            periodId,
            `Member #${current.id.slice(0, 8)} exit payout`,
            memberId,
            entryNo,
            actorUserId,
          ],
        );
        const accRes = await c.query(
          `SELECT id, code FROM chart_of_accounts
            WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
          [orgId, ['1000', '2000', '3000']],
        );
        const idByCode = new Map<string, string>();
        for (const r of accRes.rows as { id: string; code: string }[]) {
          idByCode.set(r.code, r.id);
        }
        const missing = ['1000', '2000', '3000'].find(
          (code) => !idByCode.has(code),
        );
        if (missing) throw new BadRequestException(`Unknown account code: ${missing}`);

        const values: string[] = [];
        const params: unknown[] = [];
        const pushLine = (
          accountId: string,
          debit: string,
          credit: string,
        ) => {
          const base = params.length;
          values.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
          );
          params.push(orgId, entryId, accountId, debit, credit, memberId);
        };
        for (const r of savingsRows) {
          pushLine(idByCode.get('2000')!, String(Number(r.current_balance)), '0');
        }
        if (totalShares > 0) {
          pushLine(idByCode.get('3000')!, String(totalShares), '0');
        }
        pushLine(idByCode.get('1000')!, '0', String(payout));
        await c.query(
          `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
           VALUES ${values.join(', ')}`,
          params,
        );

        // Close savings accounts with payouts + projections
        for (const r of savingsRows) {
          await c.query(
            `UPDATE member_savings_accounts
                SET current_balance = 0, status = 'CLOSED', closed_at = now()
              WHERE organization_id = $1 AND id = $2`,
            [orgId, r.id],
          );
          await c.query(
            `INSERT INTO savings_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
             VALUES ($1, $2, $3, 'WITHDRAWAL', $4, '0')`,
            [orgId, r.id, entryId, String(-Number(r.current_balance))],
          );
        }
        // Close the share account with its payout + projection
        for (const r of shareRows) {
          await c.query(
            `UPDATE member_share_accounts
                SET current_balance = 0, status = 'CLOSED', closed_at = now()
              WHERE organization_id = $1 AND id = $2`,
            [orgId, r.id],
          );
          await c.query(
            `INSERT INTO share_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
             VALUES ($1, $2, $3, 'REDEMPTION', $4, '0')`,
            [orgId, r.id, entryId, String(-Number(r.current_balance))],
          );
        }
        await c.query(
          `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
          [
            orgId,
            actorUserId,
            entryId,
            JSON.stringify({ source: 'MEMBER_EXIT_PAYOUT', entryNo, payout }),
          ],
        );
      }

      const updated = await c.query(
        `UPDATE members
            SET status = 'EXITED', updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING id, member_no, first_name, last_name, email, phone, gender,
                    status, joined_at, created_at`,
        [orgId, memberId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'member.status.exited', 'member', $3, $4)`,
        [
          orgId,
          actorUserId,
          memberId,
          JSON.stringify({
            from: current.status,
            to: 'EXITED',
            payout,
            closedAccounts: savingsRows.length + shareRows.length,
          }),
        ],
      );
      return {
        member: this.toMemberRow(updated.rows[0] as Record<string, unknown>),
        payout,
        closedAccounts: savingsRows.length + shareRows.length,
      };
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
