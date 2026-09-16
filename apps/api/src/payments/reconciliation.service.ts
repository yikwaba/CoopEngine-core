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
import { LoansService } from '../loans/loans.service';
import { SavingsService } from '../savings/savings.service';
import { SharesService } from '../shares/shares.service';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type PaymentPurpose = 'SAVINGS_DEPOSIT' | 'LOAN_REPAYMENT' | 'SHARE_PURCHASE';

export interface RecordTransactionInput {
  provider?: string;
  providerReference: string;
  amount: number;
  payerName?: string;
  payerAccount?: string;
  narration?: string;
  virtualAccountNo?: string;
  receivedAt?: string;
  raw?: unknown;
}

/**
 * Payment reconciliation: joining money that arrived to the member and purpose it was meant for.
 *
 * Two records meet here. A **payment intent** is money the cooperative is expecting, with a
 * reference the member can quote in the transfer narration. A **provider transaction** is money
 * that actually arrived (a Monnify webhook, or an officer recording what they saw on the bank
 * statement). The engine matches them, posts the money through the same services the counter
 * uses, and parks anything it cannot resolve in an exception queue — with the cash sitting in
 * Unallocated Receipts so the ledger still balances and nothing goes missing.
 *
 * Every posting carries an idempotency key derived from the provider's own reference, so a
 * replayed webhook cannot pay a member twice. That is the single most important property here.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly savings: SavingsService,
    private readonly loans: LoansService,
    private readonly shares: SharesService,
  ) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ForbiddenException('Organization context required');
    return organizationId;
  }

  private idempotencyKey(provider: string, reference: string): string {
    return `pay:${provider.toLowerCase()}:${reference}`.slice(0, 120);
  }

  // ------------------------------------------------------------------ intents

  async createIntent(
    organizationId: string | null,
    actorUserId: string,
    dto: {
      memberId: string;
      purpose?: PaymentPurpose;
      expectedAmount: number;
      reference?: string;
      dueAt?: string;
      notes?: string;
    },
  ) {
    const orgId = this.requireOrg(organizationId);
    const amount = round2(Number(dto.expectedAmount));
    if (!(amount > 0)) throw new BadRequestException('expectedAmount must be greater than zero');
    const purpose = dto.purpose ?? 'SAVINGS_DEPOSIT';

    return withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, member_no, first_name, last_name, status FROM members WHERE id = $1`,
        [dto.memberId],
      );
      const m = member.rows[0] as { id: string; member_no: number; status: string } | undefined;
      if (!m) throw new NotFoundException('Member not found');
      if (m.status === 'EXITED') {
        throw new ConflictException('This member has exited; a payment intent would be pointless');
      }

      // A reference the member can actually quote: short, unique, and traceable to them.
      const reference =
        dto.reference?.trim() ||
        `COOP-${m.member_no}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      const { rows } = await c.query(
        `INSERT INTO payment_intents
           (organization_id, member_id, purpose, reference, expected_amount, due_at, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
         RETURNING id, reference, purpose, expected_amount, status, due_at, created_at`,
        [
          orgId,
          dto.memberId,
          purpose,
          reference,
          String(amount),
          dto.dueAt ?? null,
          dto.notes ?? null,
          actorUserId,
        ],
      );
      return { ...rows[0], memberId: dto.memberId, memberNo: m.member_no };
    });
  }

  async listIntents(
    organizationId: string | null,
    filters: { status?: string; memberId?: string; limit?: number },
  ) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT i.id, i.reference, i.purpose, i.expected_amount, i.received_amount, i.status,
                i.due_at, i.notes, i.created_at, i.member_id,
                m.member_no, m.first_name || ' ' || m.last_name AS member
           FROM payment_intents i JOIN members m ON m.id = i.member_id
          WHERE ($1::text IS NULL OR i.status = $1)
            AND ($2::uuid IS NULL OR i.member_id = $2)
          ORDER BY i.created_at DESC
          LIMIT $3`,
        [filters.status ?? null, filters.memberId ?? null, Math.min(filters.limit ?? 50, 200)],
      );
      return rows;
    });
  }

  async cancelIntent(organizationId: string | null, actorUserId: string, intentId: string) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `UPDATE payment_intents SET status = 'CANCELLED', updated_at = now()
          WHERE id = $1 AND status IN ('OPEN','PARTIAL')
          RETURNING id, status`,
        [intentId],
      );
      if (!rows[0]) {
        throw new ConflictException('Only an open or partly-paid intent can be cancelled');
      }
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payment.intent.cancelled', 'payment_intent', $3, '{}'::jsonb)`,
        [orgId, actorUserId, intentId],
      );
      return rows[0];
    });
  }

  // ------------------------------------------------------------------ ingest + match

  /** Record money that arrived, then try to place it. Safe to call twice with the same reference. */
  async recordTransaction(
    organizationId: string | null,
    actorUserId: string | null,
    input: RecordTransactionInput,
  ) {
    const orgId = this.requireOrg(organizationId);
    const amount = round2(Number(input.amount));
    if (!(amount > 0)) throw new BadRequestException('amount must be greater than zero');
    if (!input.providerReference?.trim()) {
      throw new BadRequestException('providerReference is required — it is what stops double posting');
    }
    const provider = (input.provider ?? 'MANUAL').toUpperCase();

    const inserted = await withTenant(this.pool, orgId, async (c) => {
      const existing = await c.query(
        `SELECT id, status, amount FROM provider_transactions
          WHERE organization_id = $1 AND provider = $2 AND provider_reference = $3`,
        [orgId, provider, input.providerReference],
      );
      if (existing.rows[0]) return { duplicate: true, transaction: existing.rows[0] };

      const { rows } = await c.query(
        `INSERT INTO provider_transactions
           (organization_id, provider, provider_reference, amount, payer_name, payer_account,
            narration, virtual_account_no, received_at, raw, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), $10::jsonb, $11)
         RETURNING id`,
        [
          orgId,
          provider,
          input.providerReference,
          String(amount),
          input.payerName ?? null,
          input.payerAccount ?? null,
          input.narration ?? null,
          input.virtualAccountNo ?? null,
          input.receivedAt ?? null,
          JSON.stringify(input.raw ?? {}),
          actorUserId,
        ],
      );
      return { duplicate: false, transaction: rows[0] as { id: string } };
    });

    if (inserted.duplicate) {
      return { ...inserted, matched: false, note: 'This provider reference was already recorded.' };
    }
    const outcome = await this.match(orgId, actorUserId, (inserted.transaction as { id: string }).id);
    return { duplicate: false, ...outcome };
  }

  /** Place one transaction: resolve the member, find the intent, post the money. */
  async match(organizationId: string | null, actorUserId: string | null, transactionId: string) {
    const orgId = this.requireOrg(organizationId);

    const tx = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, provider, provider_reference, amount, payer_name, narration, virtual_account_no, status
           FROM provider_transactions WHERE id = $1`,
        [transactionId],
      );
      return rows[0] as
        | {
            id: string;
            provider: string;
            provider_reference: string;
            amount: string;
            payer_name: string | null;
            narration: string | null;
            virtual_account_no: string | null;
            status: string;
          }
        | undefined;
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.status === 'MATCHED') {
      return { matched: true, note: 'Already matched.', transactionId };
    }

    const amount = Number(tx.amount);
    const haystack = `${tx.narration ?? ''} ${tx.payer_name ?? ''}`.toLowerCase();

    // 1. who paid? the cooperative's own virtual account first, then a quoted reference.
    let memberId: string | null = null;
    let intentId: string | null = null;

    if (tx.virtual_account_no) {
      const va = await withTenant(this.pool, orgId, (c) =>
        c.query(
          `SELECT member_id FROM virtual_account_lookups
            WHERE organization_id = $1 AND account_number = $2 LIMIT 1`,
          [orgId, tx.virtual_account_no],
        ),
      );
      memberId = (va.rows[0] as { member_id: string } | undefined)?.member_id ?? null;
    }

    const intents = await withTenant(this.pool, orgId, (c) =>
      c.query(
        `SELECT i.id, i.member_id, i.reference, i.purpose, i.expected_amount, i.received_amount, i.status
           FROM payment_intents i
          WHERE i.status IN ('OPEN','PARTIAL')
          ORDER BY i.created_at`,
      ),
    );
    const all = intents.rows as {
      id: string;
      member_id: string;
      reference: string;
      purpose: PaymentPurpose;
      expected_amount: string;
      received_amount: string;
      status: string;
    }[];

    const byReference = all.find((i) => haystack.includes(i.reference.toLowerCase()));
    if (byReference) {
      intentId = byReference.id;
      memberId = memberId ?? byReference.member_id;
    }

    // 2. no reference quoted: for a known member, their oldest intent (a repayment if the
    //    narration says so, otherwise savings).
    if (!intentId && memberId) {
      const wantsLoan = /loan|repay|instal|installment/.test(haystack);
      const mine = all.filter((i) => i.member_id === memberId);
      const preferred =
        (wantsLoan ? mine.find((i) => i.purpose === 'LOAN_REPAYMENT') : undefined) ?? mine[0];
      intentId = preferred?.id ?? null;
    }

    // 3. still nobody: an exception, and the cash waits in Unallocated Receipts.
    if (!memberId && !intentId) {
      const entryId = await this.postUnallocated(orgId, actorUserId, tx.id, amount, tx);
      await this.mark(orgId, tx.id, {
        status: 'EXCEPTION',
        reason: `No member matched — payer "${tx.payer_name ?? 'unknown'}" and no intent reference in the narration`,
        journalEntryId: entryId,
      });
      return { matched: false, exception: true, reason: 'no-member', journalEntryId: entryId };
    }

    const purpose: PaymentPurpose =
      (all.find((i) => i.id === intentId)?.purpose as PaymentPurpose | undefined) ?? 'SAVINGS_DEPOSIT';

    try {
      const posting = await this.post(orgId, actorUserId, {
        memberId: memberId as string,
        purpose,
        amount,
        provider: tx.provider,
        reference: tx.provider_reference,
      });

      // update the intent, if there was one
      if (intentId) {
        await withTenant(this.pool, orgId, async (c) => {
          await c.query(
            `UPDATE payment_intents
                SET received_amount = received_amount + $2,
                    status = CASE WHEN received_amount + $2 >= expected_amount THEN 'MATCHED' ELSE 'PARTIAL' END,
                    updated_at = now()
              WHERE id = $1`,
            [intentId, String(amount)],
          );
        });
      }

      await this.mark(orgId, tx.id, { status: 'MATCHED', memberId, intentId, journalEntryId: posting.journalEntryId });
      return { matched: true, memberId, intentId, ...posting };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A duplicate idempotency key means this money was already posted — the replay case.
      const duplicate = /idempotency/i.test(message);
      await this.mark(orgId, tx.id, {
        status: duplicate ? 'MATCHED' : 'EXCEPTION',
        reason: duplicate ? 'Already posted for this provider reference' : message,
        memberId,
        intentId,
      });
      return { matched: duplicate, exception: !duplicate, reason: message };
    }
  }

  /** Post the money through the same service the counter uses, keyed to the provider reference. */
  private async post(
    orgId: string,
    actorUserId: string | null,
    input: {
      memberId: string;
      purpose: PaymentPurpose;
      amount: number;
      provider: string;
      reference: string;
    },
  ): Promise<{ journalEntryId?: string; target: string }> {
    const key = this.idempotencyKey(input.provider, input.reference);
    const description = `Bank transfer ${input.provider} ${input.reference}`;

    if (input.purpose === 'LOAN_REPAYMENT') {
      const loan = await withTenant(this.pool, orgId, (c) =>
        c.query(
          `SELECT id FROM loans
            WHERE member_id = $1 AND status IN ('DISBURSED','DEFAULTED')
            ORDER BY created_at LIMIT 1`,
          [input.memberId],
        ),
      );
      const loanId = (loan.rows[0] as { id: string } | undefined)?.id;
      if (!loanId) throw new ConflictException('That member has no active loan to repay');
      // Provider-initiated: journal_entries.created_by is nullable and there is no human actor.
      await this.loans.captureRepayment(orgId, actorUserId as string, loanId, input.amount, description, key);
      return { target: 'LOAN_REPAYMENT', journalEntryId: await this.entryIdForKey(orgId, key) };
    }

    if (input.purpose === 'SHARE_PURCHASE') {
      await this.shares.purchase(orgId, actorUserId as string, input.memberId, input.amount, description, key);
      return { target: 'SHARE_PURCHASE', journalEntryId: await this.entryIdForKey(orgId, key) };
    }

    const account = await withTenant(this.pool, orgId, (c) =>
      c.query(
        `SELECT id FROM member_savings_accounts
          WHERE member_id = $1 AND status = 'ACTIVE'
          ORDER BY opened_at LIMIT 1`,
        [input.memberId],
      ),
    );
    let accountId = (account.rows[0] as { id: string } | undefined)?.id;
    if (!accountId) {
      // A member paying by transfer should not be turned away because nobody opened a savings
      // account for them: open the standard one, exactly as the counter would.
      accountId = await this.openRegularSavingsAccount(orgId, input.memberId);
    }
    await this.savings.deposit(orgId, actorUserId as string, accountId, input.amount, description, key);
    return { target: 'SAVINGS_DEPOSIT', journalEntryId: await this.entryIdForKey(orgId, key) };
  }

  private async entryIdForKey(orgId: string, key: string): Promise<string | undefined> {
    const { rows } = await withTenant(this.pool, orgId, (c) =>
      c.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND idempotency_key = $2`, [
        orgId,
        key,
      ]),
    );
    return (rows[0] as { id: string } | undefined)?.id;
  }

  /** Money we cannot place yet: Dr Cash at Bank / Cr Unallocated Receipts. */
  private async postUnallocated(
    orgId: string,
    actorUserId: string | null,
    transactionId: string,
    amount: number,
    tx: { provider: string; provider_reference: string; payer_name: string | null },
  ): Promise<string | undefined> {
    const key = `${this.idempotencyKey(tx.provider, tx.provider_reference)}:unallocated`;
    return withTenant(this.pool, orgId, async (c) => {
      const existing = await c.query(
        `SELECT id FROM journal_entries WHERE organization_id = $1 AND idempotency_key = $2`,
        [orgId, key],
      );
      if (existing.rows[0]) return (existing.rows[0] as { id: string }).id;

      const period = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN'
            AND now()::date BETWEEN start_date AND end_date
          ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      const periodId = (period.rows[0] as { id: string } | undefined)?.id;
      if (!periodId) throw new ConflictException('No OPEN accounting period — cannot park the receipt');

      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      const entryNo = Number((seq.rows[0] as { journal_seq: string }).journal_seq);
      const entryId = randomUUID();

      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source, source_type, source_id,
            status, entry_no, idempotency_key, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'PAYMENT_UNALLOCATED', 'provider_transaction', $5,
                 'POSTED', $6, $7, $8, $8, now())`,
        [
          entryId,
          orgId,
          periodId,
          `Unmatched receipt: ${tx.payer_name ?? 'unknown payer'} (${tx.provider} ${tx.provider_reference})`,
          transactionId,
          entryNo,
          key,
          actorUserId,
        ],
      );

      const accounts = await c.query(
        `SELECT id, code FROM chart_of_accounts
          WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['1000', '2990']],
      );
      const idByCode = new Map(
        (accounts.rows as { id: string; code: string }[]).map((r) => [r.code, r.id]),
      );
      const cash = idByCode.get('1000');
      const suspense = idByCode.get('2990');
      if (!cash || !suspense) {
        throw new ConflictException('This cooperative is missing account 1000 or 2990');
      }
      const values: string[] = [];
      const params: unknown[] = [];
      const push = (accountId: string, debit: string, credit: string) => {
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        params.push(orgId, entryId, accountId, debit, credit, null);
      };
      push(cash, String(round2(amount)), '0');
      push(suspense, '0', String(round2(amount)));
      await c.query(
        `INSERT INTO journal_lines
           (organization_id, journal_entry_id, account_id, debit, credit, memo)
         VALUES ${values.join(', ')}`,
        params,
      );

      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payment.unallocated', 'provider_transaction', $3, $4::jsonb)`,
        [orgId, actorUserId, transactionId, JSON.stringify({ amount: round2(amount) })],
      );
      return entryId;
    });
  }

  private async mark(
    orgId: string,
    transactionId: string,
    outcome: {
      status: string;
      reason?: string;
      memberId?: string | null;
      intentId?: string | null;
      journalEntryId?: string;
    },
  ) {
    await withTenant(this.pool, orgId, (c) =>
      c.query(
        `UPDATE provider_transactions
            SET status = $2, exception_reason = $3,
                member_id = coalesce($4, member_id),
                payment_intent_id = coalesce($5, payment_intent_id),
                journal_entry_id = coalesce($6, journal_entry_id),
                updated_at = now()
          WHERE id = $1`,
        [
          transactionId,
          outcome.status,
          outcome.reason ?? null,
          outcome.memberId ?? null,
          outcome.intentId ?? null,
          outcome.journalEntryId ?? null,
        ],
      ),
    );
  }

  /** Open the cooperative's standard savings account for a member who has none. */
  private async openRegularSavingsAccount(orgId: string, memberId: string): Promise<string> {
    return withTenant(this.pool, orgId, async (c) => {
      const existing = await c.query(
        `SELECT id FROM member_savings_accounts WHERE member_id = $1 AND status = 'ACTIVE' LIMIT 1`,
        [memberId],
      );
      const found = (existing.rows[0] as { id: string } | undefined)?.id;
      if (found) return found;

      const product = await c.query(
        `SELECT id FROM savings_products WHERE organization_id = $1 AND code = 'REGULAR-SAVINGS'`,
        [orgId],
      );
      const productId = (product.rows[0] as { id: string } | undefined)?.id;
      if (!productId) throw new ConflictException('This cooperative has no REGULAR-SAVINGS product');

      const seq = await c.query(
        `UPDATE org_counters SET savings_seq = savings_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING savings_seq`,
        [orgId],
      );
      const accountNo = Number((seq.rows[0] as { savings_seq: string }).savings_seq);
      const accountId = randomUUID();
      await c.query(
        `INSERT INTO member_savings_accounts (id, organization_id, member_id, product_id, account_no, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE')`,
        [accountId, orgId, memberId, productId, accountNo],
      );
      return accountId;
    });
  }

  /** Retry everything still waiting — after an officer adds a missing member, say. */
  async sweep(organizationId: string | null, actorUserId: string | null) {
    const orgId = this.requireOrg(organizationId);
    const waiting = await withTenant(this.pool, orgId, (c) =>
      c.query(`SELECT id FROM provider_transactions WHERE status = 'UNMATCHED' ORDER BY received_at`),
    );
    const results = [];
    for (const row of waiting.rows as { id: string }[]) {
      results.push(await this.match(orgId, actorUserId, row.id));
    }
    return { attempted: results.length, matched: results.filter((r) => r.matched).length, results };
  }

  // ------------------------------------------------------------------ exceptions

  async listExceptions(organizationId: string | null) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT id, provider, provider_reference, amount, payer_name, narration, virtual_account_no,
                received_at, exception_reason, journal_entry_id
           FROM provider_transactions
          WHERE status = 'EXCEPTION'
          ORDER BY received_at DESC
          LIMIT 200`,
      );
      return rows;
    });
  }

  /** Allocate an exception to a member by hand — the officer knows who it was. */
  async assignException(
    organizationId: string | null,
    actorUserId: string,
    transactionId: string,
    dto: { memberId: string; purpose?: PaymentPurpose },
  ) {
    const orgId = this.requireOrg(organizationId);
    const tx = await withTenant(this.pool, orgId, (c) =>
      c.query(
        `SELECT id, provider, provider_reference, amount, status, journal_entry_id
           FROM provider_transactions WHERE id = $1`,
        [transactionId],
      ),
    );
    const row = tx.rows[0] as
      | { id: string; provider: string; provider_reference: string; amount: string; status: string }
      | undefined;
    if (!row) throw new NotFoundException('Transaction not found');

    const amount = Number(row.amount);

    // The money already sits in Unallocated Receipts; move it out of there and onto the member
    // in one entry, so the suspense account is drawn down rather than left holding ghosts.
    const moved = await withTenant(this.pool, orgId, async (c) => {
      const existingSuspense = await c.query(
        `SELECT id FROM journal_entries
          WHERE organization_id = $1 AND source = 'PAYMENT_ALLOCATED' AND source_id = $2`,
        [orgId, transactionId],
      );
      if (existingSuspense.rows[0]) {
        throw new ConflictException('This receipt has already been allocated');
      }

      const period = await c.query(
        `SELECT id FROM ledger_periods
          WHERE organization_id = $1 AND status = 'OPEN' AND now()::date BETWEEN start_date AND end_date
          ORDER BY start_date DESC LIMIT 1`,
        [orgId],
      );
      const periodId = (period.rows[0] as { id: string } | undefined)?.id;
      if (!periodId) throw new ConflictException('No OPEN accounting period — cannot allocate');

      const target =
        dto.purpose === 'LOAN_REPAYMENT'
          ? '1020'
          : dto.purpose === 'SHARE_PURCHASE'
            ? '3000'
            : '2000';

      const seq = await c.query(
        `UPDATE org_counters SET journal_seq = journal_seq + 1, updated_at = now()
          WHERE organization_id = $1 RETURNING journal_seq`,
        [orgId],
      );
      const entryNo = Number((seq.rows[0] as { journal_seq: string }).journal_seq);
      const entryId = randomUUID();

      await c.query(
        `INSERT INTO journal_entries
           (id, organization_id, period_id, entry_date, description, source, source_type, source_id,
            status, entry_no, created_by, posted_by, posted_at)
         VALUES ($1, $2, $3, now()::date, $4, 'PAYMENT_ALLOCATED', 'provider_transaction', $5,
                 'POSTED', $6, $7, $7, now())`,
        [
          entryId,
          orgId,
          periodId,
          `Allocated receipt ${row.provider} ${row.provider_reference}`,
          transactionId,
          entryNo,
          actorUserId,
        ],
      );

      const accounts = await c.query(
        `SELECT id, code FROM chart_of_accounts WHERE organization_id = $1 AND code = ANY($2::varchar[])`,
        [orgId, ['2990', target]],
      );
      const idByCode = new Map(
        (accounts.rows as { id: string; code: string }[]).map((r) => [r.code, r.id]),
      );
      const suspense = idByCode.get('2990');
      const destination = idByCode.get(target);
      if (!suspense || !destination) {
        throw new ConflictException(`This cooperative is missing account 2990 or ${target}`);
      }

      const values: string[] = [];
      const params: unknown[] = [];
      const push = (accountId: string, debit: string, credit: string) => {
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        params.push(orgId, entryId, accountId, debit, credit, null);
      };
      push(suspense, String(round2(amount)), '0');
      push(destination, '0', String(round2(amount)));
      await c.query(
        `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit, memo)
         VALUES ${values.join(', ')}`,
        params,
      );

      await c.query(
        `UPDATE provider_transactions
            SET status = 'MATCHED', member_id = $2, exception_reason = NULL,
                journal_entry_id = $3, updated_at = now()
          WHERE id = $1`,
        [transactionId, dto.memberId, entryId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'payment.allocated', 'provider_transaction', $3, $4::jsonb)`,
        [
          orgId,
          actorUserId,
          transactionId,
          JSON.stringify({ memberId: dto.memberId, purpose: dto.purpose ?? 'SAVINGS_DEPOSIT' }),
        ],
      );
      return { entryId, target };
    });

    return { allocated: true, transactionId, ...moved };
  }

  // ------------------------------------------------------------------ summary

  async summary(organizationId: string | null) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const counts = await c.query(
        `SELECT status, count(*)::int AS n, coalesce(sum(amount), 0)::text AS total
           FROM provider_transactions GROUP BY status`,
      );
      const intents = await c.query(
        `SELECT status, count(*)::int AS n, coalesce(sum(expected_amount), 0)::text AS expected
           FROM payment_intents GROUP BY status`,
      );
      const unallocated = await c.query(
        `SELECT coalesce(sum(jl.credit - jl.debit), 0)::text AS balance
           FROM journal_lines jl
           JOIN chart_of_accounts a ON a.id = jl.account_id
          WHERE a.code = '2990'`,
      );
      return {
        transactions: counts.rows,
        intents: intents.rows,
        unallocatedBalance: (unallocated.rows[0] as { balance: string }).balance,
      };
    });
  }
}
