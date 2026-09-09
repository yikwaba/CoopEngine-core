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

export interface SavingsProductRow {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  minDeposit: number;
  allowWithdrawal: boolean;
  status: string;
}

export interface SavingsAccountRow {
  id: string;
  accountNo: number;
  memberId: string;
  productCode: string;
  currentBalance: number;
  status: string;
  openedAt: Date;
}

export interface SavingsTxnRow {
  id: string;
  type: string;
  signedAmount: number;
  runningBalance: number;
  description: string;
  createdAt: Date;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const isPgError = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === code;

// Default account mapping (Decision Log): cash movement hits Cash at Bank
// until per-coop payment-channel settings exist.
const CASH_ACCOUNT_CODE = '1000';
const SAVINGS_LIABILITY_CODE = '2000';

@Injectable()
export class SavingsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  async listProducts(organizationId: string | null): Promise<SavingsProductRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, code, name, interest_rate_pa, min_deposit, allow_withdrawal, status
           FROM savings_products WHERE organization_id = $1 ORDER BY code`,
        [orgId],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        code: r.code as string,
        name: r.name as string,
        interestRatePa: Number(r.interest_rate_pa),
        minDeposit: Number(r.min_deposit),
        allowWithdrawal: Boolean(r.allow_withdrawal),
        status: r.status as string,
      }));
    });
  }

  /** Open the member's savings account for a product (idempotent). */
  async openAccount(
    organizationId: string | null,
    memberId: string,
    productId?: string,
  ): Promise<SavingsAccountRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, status FROM members WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      if (!member.rows[0]) throw new NotFoundException('Member not found');
      if ((member.rows[0] as { status: string }).status === 'EXITED') {
        throw new ConflictException('Cannot open an account for an exited member');
      }
      let productIdResolved = productId;
      if (!productIdResolved) {
        const def = await c.query(
          `SELECT id FROM savings_products
            WHERE organization_id = $1 AND code = 'REGULAR-SAVINGS'`,
          [orgId],
        );
        productIdResolved = (def.rows[0] as { id: string } | undefined)?.id;
      }
      if (!productIdResolved) {
        throw new NotFoundException('Savings product not found');
      }
      const existing = await c.query(
        `SELECT id, account_no, member_id, current_balance, status, opened_at
           FROM member_savings_accounts
          WHERE organization_id = $1 AND member_id = $2 AND product_id = $3`,
        [orgId, memberId, productIdResolved],
      );
      if (existing.rows[0]) {
        return this.mapAccount(existing.rows[0] as Record<string, unknown>);
      }
      await c.query(
        `INSERT INTO org_counters (organization_id) VALUES ($1)
         ON CONFLICT (organization_id) DO NOTHING`,
        [orgId],
      );
      const seq = await c.query(
        `UPDATE org_counters SET savings_seq = savings_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING savings_seq`,
        [orgId],
      );
      const accountNo = Number(
        (seq.rows[0] as { savings_seq: string | number }).savings_seq,
      );
      const ins = await c.query(
        `INSERT INTO member_savings_accounts
           (organization_id, member_id, product_id, account_no)
         VALUES ($1, $2, $3, $4)
         RETURNING id, account_no, member_id, current_balance, status, opened_at`,
        [orgId, memberId, productIdResolved, accountNo],
      );
      return this.mapAccount(ins.rows[0] as Record<string, unknown>);
    });
  }

  async getAccount(
    organizationId: string | null,
    accountId: string,
  ): Promise<SavingsAccountRow> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.account_no, a.member_id, a.current_balance, a.status, a.opened_at,
                p.code AS product_code
           FROM member_savings_accounts a
           JOIN savings_products p ON p.id = a.product_id
          WHERE a.organization_id = $1 AND a.id = $2`,
        [orgId, accountId],
      );
      if (!rows[0]) throw new NotFoundException('Savings account not found');
      return this.mapAccount(rows[0] as Record<string, unknown>);
    });
  }

  async listMemberAccounts(
    organizationId: string | null,
    memberId: string,
  ): Promise<SavingsAccountRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT a.id, a.account_no, a.member_id, a.current_balance, a.status, a.opened_at,
                p.code AS product_code
           FROM member_savings_accounts a
           JOIN savings_products p ON p.id = a.product_id
          WHERE a.organization_id = $1 AND a.member_id = $2
          ORDER BY a.account_no`,
        [orgId, memberId],
      );
      return rows.map((r) => this.mapAccount(r as Record<string, unknown>));
    });
  }

  private async runMoneyOp(
    orgId: string,
    fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<void>,
  ): Promise<void> {
    try {
      await withTenant(this.pool, orgId, async (c) => {
        await fn(c);
      });
    } catch (error) {
      if (isPgError(error, '23505')) {
        throw new ConflictException('idempotencyKey has already been used');
      }
      throw error;
    }
  }

  async deposit(
    organizationId: string | null,
    actorUserId: string,
    accountId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ): Promise<SavingsAccountRow> {
    const orgId = this.requireOrg(organizationId);
    const value = this.validateAmount(amount, 'deposit');
    await this.runMoneyOp(orgId, async (c) => {
      const account = await this.lockAccount(c, orgId, accountId);
      const entryId = randomUUID();
      const entryNo = await this.allocJournalNo(c, orgId);
      await this.insertEntryAndLines(
        c,
        orgId,
        actorUserId,
        entryId,
        entryNo,
        account,
        'SAVINGS_DEPOSIT',
        description ?? `Savings deposit to account #${account.accountNo}`,
        idempotencyKey,
        [
          // Dr Cash at Bank 1000 / Cr Member Savings Deposits 2000
          { code: CASH_ACCOUNT_CODE, side: 'debit', amount: value },
          { code: SAVINGS_LIABILITY_CODE, side: 'credit', amount: value },
        ],
      );
      const balance = round2(account.currentBalance + value);
      await this.updateBalanceAndTxn(
        c,
        orgId,
        account,
        entryId,
        'DEPOSIT',
        value,
        balance,
      );
    });
    return this.getAccount(orgId, accountId);
  }

  async withdraw(
    organizationId: string | null,
    actorUserId: string,
    accountId: string,
    amount: number,
    description?: string,
    idempotencyKey?: string,
  ): Promise<SavingsAccountRow> {
    const orgId = this.requireOrg(organizationId);
    const value = this.validateAmount(amount, 'withdrawal');
    await this.runMoneyOp(orgId, async (c) => {
      const account = await this.lockAccount(c, orgId, accountId);
      if (account.status !== 'ACTIVE') {
        throw new ConflictException('Account is not active');
      }
      const product = await c.query(
        `SELECT allow_withdrawal FROM savings_products p
           JOIN member_savings_accounts a ON a.product_id = p.id
          WHERE a.id = $1 AND a.organization_id = $2`,
        [accountId, orgId],
      );
      const allow =
        (product.rows[0] as { allow_withdrawal: boolean } | undefined)
          ?.allow_withdrawal ?? false;
      if (!allow) {
        throw new ConflictException('Product does not allow withdrawals');
      }
      if (round2(account.currentBalance - value) < 0) {
        throw new BadRequestException(
          `Insufficient balance: available ${account.currentBalance}, requested ${value}`,
        );
      }
      const entryId = randomUUID();
      const entryNo = await this.allocJournalNo(c, orgId);
      await this.insertEntryAndLines(
        c,
        orgId,
        actorUserId,
        entryId,
        entryNo,
        account,
        'SAVINGS_WITHDRAWAL',
        description ?? `Savings withdrawal from account #${account.accountNo}`,
        idempotencyKey,
        [
          // Dr Member Savings Deposits 2000 / Cr Cash at Bank 1000
          { code: SAVINGS_LIABILITY_CODE, side: 'debit', amount: value },
          { code: CASH_ACCOUNT_CODE, side: 'credit', amount: value },
        ],
      );
      const balance = round2(account.currentBalance - value);
      await this.updateBalanceAndTxn(
        c,
        orgId,
        account,
        entryId,
        'WITHDRAWAL',
        -value,
        balance,
      );
    });
    return this.getAccount(orgId, accountId);
  }

  async statement(
    organizationId: string | null,
    accountId: string,
    limit?: number,
  ): Promise<SavingsTxnRow[]> {
    const orgId = this.requireOrg(organizationId);
    await this.getAccount(orgId, accountId); // 404 if not this tenant's
    const n = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 50;
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT t.id, t.type, t.signed_amount, t.running_balance,
                je.description, t.created_at
           FROM savings_transactions t
           JOIN journal_entries je ON je.id = t.journal_entry_id
          WHERE t.organization_id = $1 AND t.account_id = $2
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $3`,
        [orgId, accountId, Math.min(Math.max(n, 1), 500)],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        type: r.type as string,
        signedAmount: Number(r.signed_amount),
        runningBalance: Number(r.running_balance),
        description: r.description as string,
        createdAt: r.created_at as Date,
      }));
    });
  }

  // ------------------------------------------------------------- helpers

  private validateAmount(amount: number, kind: string): number {
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new BadRequestException(`Invalid ${kind} amount`);
    }
    return round2(amount);
  }

  private mapAccount(row: Record<string, unknown>): SavingsAccountRow {
    return {
      id: row.id as string,
      accountNo: Number(row.account_no),
      memberId: row.member_id as string,
      productCode: (row.product_code as string | undefined) ?? 'REGULAR-SAVINGS',
      currentBalance: Number(row.current_balance),
      status: row.status as string,
      openedAt: row.opened_at as Date,
    };
  }

  /** SELECT ... FOR UPDATE inside the tenant transaction (row lock). */
  private async lockAccount(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    accountId: string,
  ): Promise<SavingsAccountRow> {
    const { rows } = await c.query(
      `SELECT a.id, a.account_no, a.member_id, a.current_balance, a.status, a.opened_at,
              p.code AS product_code
         FROM member_savings_accounts a
         JOIN savings_products p ON p.id = a.product_id
        WHERE a.organization_id = $1 AND a.id = $2
        FOR UPDATE`,
      [orgId, accountId],
    );
    if (!rows[0]) throw new NotFoundException('Savings account not found');
    return this.mapAccount(rows[0] as Record<string, unknown>);
  }

  private async allocJournalNo(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
  ): Promise<number> {
    const seq = await c.query(
      `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
        WHERE organization_id = $1 RETURNING journal_seq`,
      [orgId],
    );
    return Number((seq.rows[0] as { journal_seq: string | number }).journal_seq);
  }

  /** POSTED entry + two balanced lines in one statement (trigger-safe). */
  private async insertEntryAndLines(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    actorUserId: string,
    entryId: string,
    entryNo: number,
    account: SavingsAccountRow,
    source: string,
    description: string,
    idempotencyKey: string | undefined,
    lines: { code: string; side: 'debit' | 'credit'; amount: number }[],
  ): Promise<void> {
    if (idempotencyKey) {
      const dup = await c.query(
        `SELECT 1 FROM journal_entries
          WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [orgId, idempotencyKey],
      );
      if (dup.rows[0]) {
        throw new ConflictException('idempotencyKey has already been used');
      }
    }
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
    await c.query(
      `INSERT INTO journal_entries
         (id, organization_id, period_id, entry_date, description, source,
          source_type, source_id, status, entry_no, idempotency_key, created_by, posted_by, posted_at)
       VALUES ($1, $2, $3, now()::date, $4, $5, 'savings_account', $6, 'POSTED', $7, $8, $9, $9, now())`,
      [
        entryId,
        orgId,
        periodId,
        description,
        source,
        account.id,
        entryNo,
        idempotencyKey ?? null,
        actorUserId,
      ],
    );
    // resolve cash/liability account ids within the tenant
    const accRes = await c.query(
      `SELECT id, code FROM chart_of_accounts
        WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
      [orgId, lines.map((l) => l.code)],
    );
    const idByCode = new Map<string, string>();
    for (const r of accRes.rows as { id: string; code: string }[]) {
      idByCode.set(r.code, r.id);
    }
    const missing = lines.find((l) => !idByCode.has(l.code));
    if (missing) {
      throw new BadRequestException(`Unknown account code: ${missing.code}`);
    }
    const values: string[] = [];
    const params: unknown[] = [];
    lines.forEach((line) => {
      const base = params.length;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      );
      params.push(
        orgId,
        entryId,
        idByCode.get(line.code),
        line.side === 'debit' ? String(round2(line.amount)) : '0',
        line.side === 'credit' ? String(round2(line.amount)) : '0',
        account.memberId,
      );
    });
    await c.query(
      `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
       VALUES ${values.join(', ')}`,
      params,
    );
    await c.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
      [
        orgId,
        actorUserId,
        entryId,
        JSON.stringify({ entryNo, source, accountId: account.id }),
      ],
    );
  }

  private async updateBalanceAndTxn(
    c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    account: SavingsAccountRow,
    entryId: string,
    type: string,
    signedAmount: number,
    balance: number,
  ): Promise<void> {
    await c.query(
      `UPDATE member_savings_accounts SET current_balance = $1
        WHERE organization_id = $2 AND id = $3`,
      [String(balance), orgId, account.id],
    );
    await c.query(
      `INSERT INTO savings_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orgId,
        account.id,
        entryId,
        type,
        String(signedAmount),
        String(balance),
      ],
    );
  }

  // ----------------------------------------------- savings interest engine

  private currentPeriodCode(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private validPeriodCode(periodCode?: string): string {
    const code = periodCode ?? this.currentPeriodCode();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(code)) {
      throw new BadRequestException('period must be in YYYY-MM format');
    }
    return code;
  }

  private accrualQuery(): string {
    return `SELECT a.id AS account_id, a.member_id, m.member_no,
                   m.first_name || ' ' || m.last_name AS member,
                   p.code AS product_code, p.interest_rate_pa,
                   a.current_balance,
                   round((a.current_balance * p.interest_rate_pa / 100 / 12)::numeric, 2) AS amount
              FROM member_savings_accounts a
              JOIN members m ON m.id = a.member_id
              JOIN savings_products p ON p.id = a.product_id
             WHERE a.organization_id = $1 AND a.status = 'ACTIVE'
               AND a.current_balance > 0.004 AND p.interest_rate_pa > 0`;
  }

  /** Preview one month of savings interest at current balances/rates. */
  async interestPreview(
    organizationId: string | null,
    periodCode?: string,
  ): Promise<{
    period: string;
    total: number;
    rows: {
      accountId: string;
      memberNo: number;
      member: string;
      productCode: string;
      ratePa: number;
      balance: number;
      amount: number;
    }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    const period = this.validPeriodCode(periodCode);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(this.accrualQuery(), [orgId]);
      const data = rows.map((r: Record<string, unknown>) => ({
        accountId: r.account_id as string,
        memberNo: Number(r.member_no),
        member: r.member as string,
        productCode: r.product_code as string,
        ratePa: Number(r.interest_rate_pa),
        balance: Number(r.current_balance),
        amount: Number(r.amount),
      }));
      return {
        period,
        total: Math.round(data.reduce((a, d) => a + d.amount, 0) * 100) / 100,
        rows: data,
      };
    });
  }

  /**
   * Period-end interest posting (idempotent per org+period):
   * one balanced journal — Dr 5000 Interest on Savings / Cr 2000 Member
   * Savings Deposits per member — credited to balances and projections.
   */
  async postInterest(
    organizationId: string | null,
    actorUserId: string,
    periodCode?: string,
  ): Promise<{
    period: string;
    total: number;
    accounts: number;
    entryNo: number;
  }> {
    const orgId = this.requireOrg(organizationId);
    const period = this.validPeriodCode(periodCode);
    const postId = randomUUID();
    let entryNo = 0;
    let total = 0;
    let accounts = 0;
    await withTenant(this.pool, orgId, async (c) => {
      const already = await c.query(
        `SELECT 1 FROM savings_interest_postings
          WHERE organization_id = $1 AND period_code = $2`,
        [orgId, period],
      );
      if (already.rows[0]) {
        throw new ConflictException(`Interest already posted for ${period}`);
      }
      const periodRow = await c.query(
        `SELECT id, status FROM ledger_periods
          WHERE organization_id = $1 AND code = $2`,
        [orgId, period],
      );
      const p = periodRow.rows[0] as { id: string; status: string } | undefined;
      if (!p || p.status !== 'OPEN') {
        throw new ConflictException(`Ledger period ${period} is not OPEN`);
      }
      const { rows } = await c.query(this.accrualQuery(), [orgId]);
      const accruals = rows.map((r: Record<string, unknown>) => ({
        accountId: r.account_id as string,
        memberId: r.member_id as string,
        amount: Number(r.amount),
      })).filter((a) => a.amount > 0.004);
      if (accruals.length === 0) {
        throw new BadRequestException('No savings balances with a positive rate — nothing to post');
      }
      total = Math.round(accruals.reduce((a, x) => a + x.amount, 0) * 100) / 100;

      const accRes = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['2000', '5000']],
      );
      const idByCode = new Map<string, string>();
      for (const r of accRes.rows as { id: string; code: string }[]) {
        idByCode.set(r.code, r.id);
      }
      const missing = ['2000', '5000'].find((code) => !idByCode.has(code));
      if (missing) throw new BadRequestException(`Unknown account code: ${missing}`);

      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      entryNo = Number((seq.rows[0] as { journal_seq: string | number }).journal_seq);
      const entryId = randomUUID();
      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source,
            source_type, source_id, status, entry_no, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'SAVINGS_INTEREST', 'interest_posting', $5,
                 'POSTED', $6, $7, $7, now())`,
        [
          entryId,
          orgId,
          p.id,
          `Interest on savings ${period}`,
          postId,
          entryNo,
          actorUserId,
        ],
      );

      // Dr 5000 (expense) + Cr 2000 (liability) per member, one statement
      const values: string[] = [];
      const params: unknown[] = [];
      const pushLine = (accountId: string, debit: string, credit: string, memberId: string) => {
        const base = params.length;
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
        );
        params.push(orgId, entryId, accountId, debit, credit, memberId);
      };
      for (const a of accruals) {
        const amount = String(a.amount);
        pushLine(idByCode.get('5000')!, amount, '0', a.memberId);
        pushLine(idByCode.get('2000')!, '0', amount, a.memberId);
      }
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, member_id)
         VALUES ${values.join(', ')}`,
        params,
      );

      // Credit balances + projections
      for (const a of accruals) {
        const bal = await c.query(
          `SELECT current_balance FROM member_savings_accounts
            WHERE organization_id = $1 AND id = $2`,
          [orgId, a.accountId],
        );
        const before = Number((bal.rows[0] as { current_balance: string }).current_balance);
        const after = Math.round((before + a.amount) * 100) / 100;
        await c.query(
          `UPDATE member_savings_accounts SET current_balance = $1
            WHERE organization_id = $2 AND id = $3`,
          [String(after), orgId, a.accountId],
        );
        await c.query(
          `INSERT INTO savings_transactions (organization_id, account_id, journal_entry_id, type, signed_amount, running_balance)
           VALUES ($1, $2, $3, 'INTEREST', $4, $5)`,
          [orgId, a.accountId, entryId, String(a.amount), String(after)],
        );
      }

      await c.query(
        `INSERT INTO savings_interest_postings (id, organization_id, period_code, total_amount, entry_id, posted_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [postId, orgId, period, String(total), entryId, actorUserId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'journal.auto.posted', 'journal_entry', $3, $4)`,
        [
          orgId,
          actorUserId,
          entryId,
          JSON.stringify({ source: 'SAVINGS_INTEREST', period, entryNo, total }),
        ],
      );
      accounts = accruals.length;
    });
    return { period, total, accounts, entryNo };
  }
}
