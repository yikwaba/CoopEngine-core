import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import {
  CreateJournalDto,
  JournalLineDto,
} from './dto/ledger.dto';

export type JournalStatus = 'DRAFT' | 'SUBMITTED' | 'POSTED' | 'REVERSED';

export interface JournalEntryRow {
  id: string;
  entryNo: number | null;
  entryDate: string;
  description: string;
  source: string;
  status: JournalStatus;
  createdBy: string | null;
  createdAt: Date;
}

export interface JournalLineRow {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
  memo: string | null;
  memberId: string | null;
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  category: string | null;
  isSystem: boolean;
  isActive: boolean;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  balance: number;
}

export interface PeriodRow {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
}

/** Money rounding for the ledger (2dp, half away from zero). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const isPgError = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === code;

const isImbalance = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  String((e as { message?: string }).message ?? '').includes('journal_imbalance');

@Injectable()
export class LedgerService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  // ------------------------------------------------------------ read side

  async listAccounts(organizationId: string | null): Promise<AccountRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code, name, type, category, is_system, is_active
           FROM chart_of_accounts WHERE organization_id = $1 ORDER BY code`,
        [orgId],
      );
      return rows.map((r) => ({
        id: r.id as string,
        code: r.code as string,
        name: r.name as string,
        type: r.type as string,
        category: (r.category as string | null) ?? null,
        isSystem: Boolean(r.is_system),
        isActive: Boolean(r.is_active),
      }));
    });
  }

  async listPeriods(organizationId: string | null): Promise<PeriodRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code, start_date, end_date, status
           FROM ledger_periods WHERE organization_id = $1 ORDER BY code DESC`,
        [orgId],
      );
      return rows.map((r) => ({
        id: r.id as string,
        code: r.code as string,
        startDate: r.start_date as string,
        endDate: r.end_date as string,
        status: r.status as string,
      }));
    });
  }

  async listJournals(
    organizationId: string | null,
    status?: string,
  ): Promise<JournalEntryRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [orgId];
      let where = `organization_id = $1`;
      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      const { rows } = await c.query(
        `SELECT id, entry_no, entry_date, description, source, status, created_by, created_at
           FROM journal_entries WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
        params,
      );
      return rows.map((r) => ({
        id: r.id as string,
        entryNo: r.entry_no === null ? null : Number(r.entry_no),
        entryDate: (r.entry_date as Date).toISOString().slice(0, 10),
        description: r.description as string,
        source: r.source as string,
        status: r.status as JournalStatus,
        createdBy: (r.created_by as string | null) ?? null,
        createdAt: r.created_at as Date,
      }));
    });
  }

  async getJournal(
    organizationId: string | null,
    journalId: string,
  ): Promise<{ entry: JournalEntryRow; lines: JournalLineRow[] }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, entry_no, entry_date, description, source, status, created_by, created_at
           FROM journal_entries WHERE organization_id = $1 AND id = $2`,
        [orgId, journalId],
      );
      if (!rows[0]) throw new NotFoundException('Journal entry not found');
      const entry = rows[0] as Record<string, unknown>;
      const lines = await c.query(
        `SELECT a.code AS account_code, a.name AS account_name, a.type AS account_type,
                jl.debit, jl.credit, jl.memo, jl.member_id
           FROM journal_lines jl
           JOIN chart_of_accounts a ON a.id = jl.account_id
          WHERE jl.organization_id = $1 AND jl.journal_entry_id = $2
          ORDER BY jl.created_at`,
        [orgId, journalId],
      );
      return {
        entry: {
          id: entry.id as string,
          entryNo: entry.entry_no === null ? null : Number(entry.entry_no),
          entryDate: (entry.entry_date as Date).toISOString().slice(0, 10),
          description: entry.description as string,
          source: entry.source as string,
          status: entry.status as JournalStatus,
          createdBy: (entry.created_by as string | null) ?? null,
          createdAt: entry.created_at as Date,
        },
        lines: lines.rows.map((l: Record<string, unknown>) => ({
          accountCode: l.account_code as string,
          accountName: l.account_name as string,
          accountType: l.account_type as string,
          debit: Number(l.debit),
          credit: Number(l.credit),
          memo: (l.memo as string | null) ?? null,
          memberId: (l.member_id as string | null) ?? null,
        })),
      };
    });
  }

  async trialBalance(
    organizationId: string | null,
    periodCode?: string,
  ): Promise<{ period: string; net: number; rows: TrialBalanceRow[] }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const params: unknown[] = [orgId];
      let periodFilter = '';
      if (periodCode) {
        params.push(periodCode);
        periodFilter = `AND lp.code = $${params.length}`;
      }
      const { rows } = await c.query(
        `SELECT a.code, a.name, a.type,
                COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           JOIN ledger_periods lp ON lp.id = je.period_id
           JOIN chart_of_accounts a ON a.id = jl.account_id
          WHERE je.organization_id = $1 AND je.status = 'POSTED' ${periodFilter}
          GROUP BY a.code, a.name, a.type
          ORDER BY a.code`,
        params,
      );
      const rowsOut = rows.map((r: Record<string, unknown>) => ({
        code: r.code as string,
        name: r.name as string,
        type: r.type as string,
        balance: Number(r.balance),
      }));
      return {
        period: periodCode ?? 'all',
        net: round2(rowsOut.reduce((acc, r) => acc + r.balance, 0)),
        rows: rowsOut,
      };
    });
  }

  // ----------------------------------------------------------- write side

  /** Create a DRAFT entry with balanced lines (maker step). */
  async createDraft(
    organizationId: string | null,
    actorUserId: string,
    dto: CreateJournalDto,
  ): Promise<JournalEntryRow> {
    const orgId = this.requireOrg(organizationId);
    this.validateLines(dto.lines);
    const entryId = randomUUID();
    try {
      await withTenant(this.pool, orgId, async (c) => {
        // entryDate must fall inside an existing OPEN period (FR-052)
        const period = await c.query(
          `SELECT id, status FROM ledger_periods
            WHERE organization_id = $1 AND $2::date BETWEEN start_date AND end_date`,
          [orgId, dto.entryDate],
        );
        const p = period.rows[0] as { id: string; status: string } | undefined;
        if (!p) {
          throw new BadRequestException(
            `No accounting period covers ${dto.entryDate}; open one first`,
          );
        }
        if (p.status !== 'OPEN') {
          throw new ConflictException(
            `Period covering ${dto.entryDate} is ${p.status} — posting not allowed`,
          );
        }
        await c.query(
          `INSERT INTO journal_entries
             (id, organization_id, period_id, entry_date, description, source, status, idempotency_key, created_by)
           VALUES ($1, $2, $3, $4, $5, 'MANUAL', 'DRAFT', $6, $7)`,
          [
            entryId,
            orgId,
            p.id,
            dto.entryDate,
            dto.description,
            dto.idempotencyKey ?? null,
            actorUserId,
          ],
        );
        const accountIds = await this.resolveAccounts(c, orgId, dto.lines);
        // Single multi-row insert: the balance trigger is statement-level, so
        // all lines of an entry must land in ONE statement.
        const values: string[] = [];
        const params: unknown[] = [];
        dto.lines.forEach((line) => {
          const base = params.length;
          values.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
          );
          params.push(
            orgId,
            entryId,
            accountIds.get(line.accountCode),
            line.debit ? String(round2(line.debit)) : '0',
            line.credit ? String(round2(line.credit)) : '0',
            line.memo ?? null,
            line.memberId ?? null,
          );
        });
        await c.query(
          `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, memo, member_id)
           VALUES ${values.join(', ')}`,
          params,
        );
      });
      return this.getJournal(orgId, entryId).then((j) => j.entry);
    } catch (error) {
      if (isPgError(error, '23505')) {
        throw new ConflictException('idempotencyKey has already been used');
      }
      if (isImbalance(error)) {
        throw new BadRequestException(
          'Journal is unbalanced: debits must equal credits with at least two lines',
        );
      }
      throw error;
    }
  }

  /** DRAFT -> SUBMITTED (maker submits for checking). */
  async submit(
    organizationId: string | null,
    _actorUserId: string,
    journalId: string,
  ): Promise<JournalEntryRow> {
    const orgId = this.requireOrg(organizationId);
    await withTenant(this.pool, orgId, async (c) => {
      await this.requireState(c, orgId, journalId, 'DRAFT');
      await c.query(
        `UPDATE journal_entries SET status = 'SUBMITTED' WHERE id = $1`,
        [journalId],
      );
    });
    return (await this.getJournal(orgId, journalId)).entry;
  }

  /** SUBMITTED -> POSTED (checker); allocates the sequential entry number. */
  async approveAndPost(
    organizationId: string | null,
    actorUserId: string,
    journalId: string,
  ): Promise<JournalEntryRow> {
    const orgId = this.requireOrg(organizationId);
    let entryNo = 0;
    let maker: string | null = null;
    await withTenant(this.pool, orgId, async (c) => {
      const current = await this.requireState(c, orgId, journalId, 'SUBMITTED');
      maker = current.created_by;
      const period = await c.query(
        `SELECT lp.status FROM journal_entries je
           JOIN ledger_periods lp ON lp.id = je.period_id
          WHERE je.id = $1 AND je.organization_id = $2`,
        [journalId, orgId],
      );
      const p = period.rows[0] as { status: string } | undefined;
      if (!p || p.status !== 'OPEN') {
        throw new ConflictException(
          'The covering accounting period is not OPEN — cannot post',
        );
      }
      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      entryNo = Number(
        (seq.rows[0] as { journal_seq: string | number }).journal_seq,
      );
      await c.query(
        `UPDATE journal_entries
            SET status = 'POSTED', entry_no = $1, posted_by = $2, posted_at = now()
          WHERE id = $3`,
        [entryNo, actorUserId, journalId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'journal.posted', 'journal_entry', $3, $4)`,
        [
          orgId,
          actorUserId,
          journalId,
          JSON.stringify({ entryNo, maker }),
        ],
      );
    });
    void entryNo;
    return (await this.getJournal(orgId, journalId)).entry;
  }

  /**
   * Reverse a POSTED entry: creates a linked opposite entry (source REVERSAL)
   * and marks the original REVERSED. Append-only — nothing is deleted.
   */
  async reverse(
    organizationId: string | null,
    actorUserId: string,
    journalId: string,
    reason: string,
  ): Promise<{ reversal: JournalEntryRow }> {
    const orgId = this.requireOrg(organizationId);
    if (!reason?.trim()) {
      throw new BadRequestException('A reversal reason is required');
    }
    const reversalId = randomUUID();
    await withTenant(this.pool, orgId, async (c) => {
      const current = await this.requireState(c, orgId, journalId, 'POSTED');
      const original = await this.getJournal(orgId, journalId);

      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, created_by, reversal_of_entry_id)
         VALUES ($1, $2, $3, $4, $5, 'REVERSAL', 'journal_entry', $6, 'POSTED', $7, $6)`,
        [
          reversalId,
          orgId,
          current.period_id,
          original.entry.entryDate,
          `Reversal of entry #${original.entry.entryNo ?? ''}: ${reason}`,
          journalId,
          actorUserId,
        ],
      );
      const codes = [...new Set(original.lines.map((l) => l.accountCode))];
      const accRes = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, codes],
      );
      const idByCode = new Map<string, string>();
      for (const r of accRes.rows as { id: string; code: string }[]) {
        idByCode.set(r.code, r.id);
      }
      // Single multi-row insert (statement-level balance trigger).
      const values: string[] = [];
      const params: unknown[] = [];
      original.lines.forEach((line) => {
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        params.push(
          orgId,
          reversalId,
          idByCode.get(line.accountCode),
          String(round2(line.credit)), // debit mirrors the original credit
          String(round2(line.debit)), // credit mirrors the original debit
          `Reversal: ${reason}`,
        );
      });
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, memo)
         VALUES ${values.join(', ')}`,
        params,
      );
      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      const reversalNo = Number(
        (seq.rows[0] as { journal_seq: string | number }).journal_seq,
      );
      await c.query(
        `UPDATE journal_entries SET entry_no = $1, posted_by = $2, posted_at = now()
          WHERE id = $3`,
        [reversalNo, actorUserId, reversalId],
      );
      await c.query(
        `UPDATE journal_entries SET status = 'REVERSED' WHERE id = $1`,
        [journalId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'journal.reversed', 'journal_entry', $3, $4)`,
        [
          orgId,
          actorUserId,
          journalId,
          JSON.stringify({ reversalId, entryNo: reversalNo, reason }),
        ],
      );
    });
    return { reversal: (await this.getJournal(orgId, reversalId)).entry };
  }

  // -------------------------------------------------------------- helpers

  private validateLines(lines: JournalLineDto[]): void {
    for (const line of lines) {
      const hasDebit = typeof line.debit === 'number';
      const hasCredit = typeof line.credit === 'number';
      if (hasDebit === hasCredit) {
        throw new BadRequestException(
          `Each line needs exactly one side: debit XOR credit (account ${line.accountCode})`,
        );
      }
    }
    const totalDebit = round2(
      lines.reduce((acc, l) => acc + (l.debit ?? 0), 0),
    );
    const totalCredit = round2(
      lines.reduce((acc, l) => acc + (l.credit ?? 0), 0),
    );
    if (totalDebit !== totalCredit) {
      throw new BadRequestException(
        `Unbalanced journal: debits ${totalDebit} != credits ${totalCredit}`,
      );
    }
    if (totalDebit <= 0) {
      throw new BadRequestException('Journal total must be greater than zero');
    }
  }

  private async resolveAccounts(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    lines: JournalLineDto[],
  ): Promise<Map<string, string>> {
    const codes = [...new Set(lines.map((l) => l.accountCode))];
    const { rows } = await c.query(
      `SELECT id, code, is_active FROM chart_of_accounts
        WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
      [orgId, codes],
    );
    const byCode = new Map<string, { id: string; is_active: boolean }>();
    for (const r of rows as { id: string; code: string; is_active: boolean }[]) {
      byCode.set(r.code, r);
    }
    for (const code of codes) {
      const account = byCode.get(code);
      if (!account) {
        throw new BadRequestException(`Unknown account code: ${code}`);
      }
      if (!account.is_active) {
        throw new BadRequestException(`Account is inactive: ${code}`);
      }
    }
    const ids = new Map<string, string>();
    for (const [code, account] of byCode) {
      ids.set(code, account.id);
    }
    return ids;
  }

  private async requireState(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    journalId: string,
    expected: JournalStatus,
  ): Promise<{ id: string; status: string; period_id: string; created_by: string | null }> {
    const { rows } = await c.query(
      `SELECT id, status, period_id, created_by FROM journal_entries
        WHERE organization_id = $1 AND id = $2`,
      [orgId, journalId],
    );
    const entry = rows[0] as
      | { id: string; status: string; period_id: string; created_by: string | null }
      | undefined;
    if (!entry) throw new NotFoundException('Journal entry not found');
    if (entry.status !== expected) {
      throw new ConflictException(
        `Journal is ${entry.status}, expected ${expected}`,
      );
    }
    return entry;
  }
}
