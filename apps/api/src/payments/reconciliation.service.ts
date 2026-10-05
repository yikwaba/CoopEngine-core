import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { LoansService } from '../loans/loans.service';
import { SavingsService } from '../savings/savings.service';
import { SharesService } from '../shares/shares.service';

import { financialIntent } from '../common/financial-intent';
import { moneyDecimal, moneyKobo } from '../common/money';

export type PaymentPurpose = 'SAVINGS_DEPOSIT' | 'LOAN_REPAYMENT' | 'SHARE_PURCHASE';

export interface RecordTransactionInput {
  provider?: string;
  providerReference: string;
  amount: string | number;
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

  private idempotencyKey(orgId: string, provider: string, reference: string, allocationId?: string): string {
    // Full reference and tenant are hashed: no prefix truncation or cross-tenant journal collision.
    return 'pay:' + createHash('sha256').update(JSON.stringify([orgId,provider.toUpperCase(),reference,allocationId??null])).digest('hex');
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
    const amount = moneyDecimal(moneyKobo(dto.expectedAmount));
    if (moneyKobo(amount) <= 0n) throw new BadRequestException('expectedAmount must be greater than zero');
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

  /** Receipt, posting, intent total and matching state commit together. */
  async recordTransaction(
    organizationId: string | null,
    actorUserId: string | null,
    input: RecordTransactionInput,
    existingClient?: PoolClient,
  ) {
    const orgId = this.requireOrg(organizationId);
    const amount = moneyDecimal(moneyKobo(input.amount));
    if (moneyKobo(amount) <= 0n) throw new BadRequestException('amount must be greater than zero');
    const reference = input.providerReference?.trim();
    if (!reference || reference.length > 128) throw new BadRequestException('providerReference must contain 1 to 128 characters');
    const provider = (input.provider ?? 'MANUAL').toUpperCase();
    const run = async (c: PoolClient) => {
      // Serialize ingestion before its unique-index check; duplicate callbacks wait for commit.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify([orgId,'provider-record',provider,reference])]);
      const existing = await c.query(
        `SELECT id,status,amount,narration,payer_name,payer_account,virtual_account_no,journal_entry_id,member_id,payment_intent_id
           FROM provider_transactions WHERE organization_id=$1 AND provider=$2 AND provider_reference=$3 FOR UPDATE`,
        [orgId,provider,reference],
      );
      const row = existing.rows[0];
      if (row) {
        if (moneyKobo(row.amount) !== moneyKobo(amount)
          || (row.narration ?? null) !== (input.narration ?? null)
          || (row.payer_name ?? null) !== (input.payerName ?? null)
          || (row.payer_account ?? null) !== (input.payerAccount ?? null)
          || (row.virtual_account_no ?? null) !== (input.virtualAccountNo ?? null)) {
          throw new ConflictException('This provider reference was already recorded with different payment details');
        }
        const outcome = row.status === 'UNMATCHED'
          ? await this.matchTx(c,orgId,actorUserId,row.id)
          : {matched:row.status === 'MATCHED',exception:row.status === 'EXCEPTION',transactionId:row.id,
              memberId:row.member_id,intentId:row.payment_intent_id,journalEntryId:row.journal_entry_id};
        return {duplicate:true,transaction:{id:row.id,status:row.status,amount:row.amount},
          ...outcome,note:'This provider reference was already recorded.'};
      }
      const {rows} = await c.query(
        `INSERT INTO provider_transactions
          (organization_id,provider,provider_reference,amount,payer_name,payer_account,narration,
           virtual_account_no,received_at,raw,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz,now()),$10::jsonb,$11) RETURNING id`,
        [orgId,provider,reference,amount,input.payerName??null,input.payerAccount??null,input.narration??null,
          input.virtualAccountNo??null,input.receivedAt??null,JSON.stringify(input.raw??{}),actorUserId],
      );
      return {duplicate:false,...await this.matchTx(c,orgId,actorUserId,rows[0].id)};
    };
    return existingClient ? run(existingClient) : withTenant(this.pool,orgId,run);
  }

  async match(organizationId: string | null, actorUserId: string | null, transactionId: string) {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool,orgId,c=>this.matchTx(c,orgId,actorUserId,transactionId));
  }

  private async matchTx(c: PoolClient, orgId: string, actorUserId: string | null, transactionId: string) {
    // Every match/assignment locks this row before claiming a receipt: one consistent lock order.
    const {rows} = await c.query(`SELECT * FROM provider_transactions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,transactionId]);
    const tx = rows[0];
    if (!tx) throw new NotFoundException('Transaction not found');
    return financialIntent(this.pool,orgId,'provider.match',`provider-match:${transactionId}`,
      {transactionId},async()=>{
        if (tx.status === 'MATCHED') {
          if (!tx.journal_entry_id) throw new ConflictException('Historical matched receipt has no journal link; reconciliation is required');
          return {matched:true,note:'Already matched.',transactionId,journalEntryId:tx.journal_entry_id};
        }
        if (tx.status === 'EXCEPTION') {
          // A parked receipt must be assigned from suspense, never posted from cash again.
          return {matched:false,exception:true,transactionId,reason:tx.exception_reason,journalEntryId:tx.journal_entry_id};
        }
        if (tx.status !== 'UNMATCHED') throw new ConflictException('Receipt is not available for matching');
        // Historical partially committed postings cannot be inferred from an error string.
        const legacyKey = `pay:${tx.provider.toLowerCase()}:${tx.provider_reference}`.slice(0,120);
        const legacy = await c.query(`SELECT id FROM journal_entries WHERE organization_id=$1 AND idempotency_key=ANY($2::varchar[])`,
          [orgId,[legacyKey,legacyKey+':unallocated',this.idempotencyKey(orgId,tx.provider,tx.provider_reference)]]);
        if (legacy.rowCount) throw new ConflictException('Historical provider posting exists without matching state; reconciliation is required');
        const haystack = `${tx.narration??''} ${tx.payer_name??''}`.toLowerCase();
        let memberId: string | null = null;
        if (tx.virtual_account_no) {
          const va = await c.query(`SELECT member_id FROM virtual_account_lookups WHERE organization_id=$1 AND account_number=$2 LIMIT 1`,[orgId,tx.virtual_account_no]);
          memberId=va.rows[0]?.member_id??null;
        }
        const intents = await c.query(`SELECT id,member_id,reference,purpose FROM payment_intents WHERE status IN ('OPEN','PARTIAL') ORDER BY created_at,id`);
        const quoted = intents.rows.find(i=>haystack.includes(i.reference.toLowerCase()));
        if (quoted && memberId && quoted.member_id !== memberId) throw new ConflictException('Virtual account and payment intent identify different members');
        memberId=memberId??quoted?.member_id??null;
        const mine=intents.rows.filter(i=>i.member_id===memberId);
        const selected=quoted??(/loan|repay|instal|installment/.test(haystack)?mine.find(i=>i.purpose==='LOAN_REPAYMENT'):undefined)??mine[0];
        const intentId: string | null=selected?.id??null;
        if (intentId) {
          const locked=await c.query(`SELECT status FROM payment_intents WHERE id=$1 FOR UPDATE`,[intentId]);
          if (!locked.rows[0] || locked.rows[0].status==='CANCELLED') throw new ConflictException('Payment intent is no longer available');
        }
        const amount=moneyDecimal(moneyKobo(tx.amount));
        if (!memberId) {
          const entryId=await this.postUnallocated(c,orgId,actorUserId,tx.id,amount,tx);
          const reason=`No member matched — payer "${tx.payer_name??'unknown'}" and no intent reference in the narration`;
          await this.mark(c,orgId,tx.id,{status:'EXCEPTION',reason,journalEntryId:entryId});
          return {matched:false,exception:true,transactionId,reason:'no-member',journalEntryId:entryId};
        }
        const posting=await this.post(c,orgId,actorUserId,{memberId,purpose:selected?.purpose??'SAVINGS_DEPOSIT',amount,
          provider:tx.provider,reference:tx.provider_reference});
        if (intentId) await c.query(`UPDATE payment_intents SET received_amount=received_amount+$2,
          status=CASE WHEN received_amount+$2>=expected_amount THEN 'MATCHED' ELSE 'PARTIAL' END,updated_at=now() WHERE id=$1`,[intentId,amount]);
        await this.mark(c,orgId,tx.id,{status:'MATCHED',memberId,intentId,journalEntryId:posting.journalEntryId});
        return {matched:true,transactionId,memberId,intentId,...posting};
      },c);
  }

  /** Reuse each domain posting inside the caller's transaction, including member projections. */
  private async post(
    c: PoolClient, orgId: string, actorUserId: string | null,
    input: {memberId:string;purpose:PaymentPurpose;amount:string;provider:string;reference:string},
    allocationId?: string,
  ): Promise<{journalEntryId:string;target:string}> {
    const member=await c.query(`SELECT status FROM members WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE`,[orgId,input.memberId]);
    if (!member.rows[0]) throw new NotFoundException('Member not found');
    if (member.rows[0].status!=='ACTIVE') throw new ConflictException('Only ACTIVE members can receive allocated payments');
    const key=this.idempotencyKey(orgId,input.provider,input.reference,allocationId);
    const description=`Bank transfer ${input.provider} ${input.reference}`;
    await this.lockOpenPeriod(c,orgId);
    if (input.purpose==='LOAN_REPAYMENT') {
      const loan=await c.query(`SELECT id FROM loans WHERE member_id=$1 AND status='DISBURSED' ORDER BY created_at,id LIMIT 1`,[input.memberId]);
      if (!loan.rows[0]) throw new ConflictException('That member has no active loan to repay');
      await this.loans.captureRepayment(orgId,actorUserId as string,loan.rows[0].id,input.amount,description,key,c);
    } else if (input.purpose==='SHARE_PURCHASE') {
      await this.shares.purchase(orgId,actorUserId as string,input.memberId,input.amount,description,key,c);
    } else {
      const accountId=await this.openRegularSavingsAccount(c,orgId,input.memberId);
      await this.savings.deposit(orgId,actorUserId as string,accountId,input.amount,description,key,c);
    }
    const entry=await c.query(`SELECT id FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2`,[orgId,key]);
    if (!entry.rows[0]) throw new ConflictException('Provider posting did not produce a journal link');
    return {target:input.purpose,journalEntryId:entry.rows[0].id};
  }

  private async lockOpenPeriod(c: PoolClient, orgId: string) {
    const period=await c.query(`SELECT id FROM ledger_periods WHERE organization_id=$1 AND status='OPEN'
      AND now()::date BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1 FOR SHARE`,[orgId]);
    if (!period.rows[0]) throw new ConflictException('No OPEN accounting period — cannot post');
    return period.rows[0].id as string;
  }

  /** Money we cannot place yet: Dr Cash at Bank / Cr Unallocated Receipts. */
  private async postUnallocated(
    c: PoolClient,
    orgId: string,
    actorUserId: string | null,
    transactionId: string,
    amount: string,
    tx: { provider: string; provider_reference: string; payer_name: string | null },
  ): Promise<string> {
    const key = `${this.idempotencyKey(orgId, tx.provider, tx.provider_reference)}:unallocated`;

    const existing = await c.query(
      `SELECT id FROM journal_entries WHERE organization_id = $1 AND idempotency_key = $2`,
      [orgId, key],
    );
    if (existing.rows[0]) return (existing.rows[0] as { id: string }).id;

    const periodId = await this.lockOpenPeriod(c,orgId);

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
    push(cash, amount, '0');
    push(suspense, '0', amount);
    await c.query(
      `INSERT INTO journal_lines
         (organization_id, journal_entry_id, account_id, debit, credit, memo)
       VALUES ${values.join(', ')}`,
      params,
    );

    await c.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'payment.unallocated', 'provider_transaction', $3, $4::jsonb)`,
      [orgId, actorUserId, transactionId, JSON.stringify({ amount })],
    );
    return entryId;

  }

  private async mark(
    c: PoolClient,
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
    await c.query(
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
    );
  }

  /** Open the cooperative's standard savings account for a member who has none. */
  private async openRegularSavingsAccount(c: PoolClient, orgId: string, memberId: string): Promise<string> {

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

  /** Assign the parked receipt once; suspense release and domain posting share one commit. */
  async assignException(
    organizationId: string | null, actorUserId: string, transactionId: string,
    dto: {memberId:string;purpose?:PaymentPurpose},
  ) {
    const orgId=this.requireOrg(organizationId),purpose=dto.purpose??'SAVINGS_DEPOSIT';
    return withTenant(this.pool,orgId,async c=>{
      const {rows}=await c.query(`SELECT * FROM provider_transactions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,transactionId]);
      const tx=rows[0];
      if (!tx) throw new NotFoundException('Transaction not found');
      return financialIntent(this.pool,orgId,'provider.assign',`provider-assign:${transactionId}`,
        {transactionId,memberId:dto.memberId,purpose},async()=>{
          if (tx.status!=='EXCEPTION' || !tx.journal_entry_id) throw new ConflictException('Only a parked exception can be allocated; historical incomplete receipts require reconciliation');
          const original=await c.query(`SELECT je.id FROM journal_entries je WHERE je.organization_id=$1 AND je.id=$2
            AND je.source='PAYMENT_UNALLOCATED' AND je.source_id=$3 AND je.status='POSTED' FOR UPDATE`,[orgId,tx.journal_entry_id,transactionId]);
          if (!original.rowCount) throw new ConflictException('Receipt has no valid posted suspense journal');
          const lines=await c.query(`SELECT a.code,jl.debit,jl.credit FROM journal_lines jl JOIN chart_of_accounts a ON a.id=jl.account_id WHERE jl.journal_entry_id=$1 ORDER BY a.code`,[tx.journal_entry_id]);
          const amount=moneyDecimal(moneyKobo(tx.amount));
          if (lines.rows.length!==2 || lines.rows[0].code!=='1000' || lines.rows[1].code!=='2990'
            || moneyKobo(lines.rows[0].debit)!==moneyKobo(amount) || moneyKobo(lines.rows[0].credit)!==0n
            || moneyKobo(lines.rows[1].credit)!==moneyKobo(amount) || moneyKobo(lines.rows[1].debit)!==0n) {
            throw new ConflictException('Suspense journal does not reconcile to this receipt');
          }
          const allocated=await c.query(`SELECT id FROM journal_entries WHERE organization_id=$1 AND source='PAYMENT_ALLOCATED' AND source_id=$2`,[orgId,transactionId]);
          if (allocated.rowCount) throw new ConflictException('Historical allocation exists without a retry receipt; reconciliation is required');
          // Post first to preserve member/account-before-counter lock ordering. The balanced
          // clearing entry below offsets its cash debit: net Dr Suspense / Cr member destination.
          const posting=await this.post(c,orgId,actorUserId,{memberId:dto.memberId,purpose,amount,
            provider:tx.provider,reference:tx.provider_reference},transactionId);
          const period=await c.query(`SELECT id FROM ledger_periods WHERE organization_id=$1 AND status='OPEN'
            AND now()::date BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1`,[orgId]);
          if (!period.rows[0]) throw new ConflictException('No OPEN accounting period — cannot allocate');
          const seq=await c.query(`UPDATE org_counters SET journal_seq=journal_seq+1,updated_at=now() WHERE organization_id=$1 RETURNING journal_seq`,[orgId]);
          const entryId=randomUUID();
          await c.query(`INSERT INTO journal_entries
            (id,organization_id,period_id,entry_date,description,source,source_type,source_id,status,entry_no,created_by,posted_by,posted_at)
            VALUES ($1,$2,$3,now()::date,$4,'PAYMENT_ALLOCATED','provider_transaction',$5,'POSTED',$6,$7,$7,now())`,
            [entryId,orgId,period.rows[0].id,`Release suspense ${tx.provider} ${tx.provider_reference}`,transactionId,seq.rows[0].journal_seq,actorUserId]);
          const accounts=await c.query(`SELECT id,code FROM chart_of_accounts WHERE organization_id=$1 AND code=ANY($2::varchar[])`,[orgId,['1000','2990']]);
          const byCode=new Map(accounts.rows.map(a=>[a.code,a.id]));
          if (!byCode.has('1000') || !byCode.has('2990')) throw new ConflictException('Missing cash or suspense account');
          await c.query(`INSERT INTO journal_lines (organization_id,journal_entry_id,account_id,debit,credit,member_id)
            VALUES ($1,$2,$3,$4,0,$5),($1,$2,$6,0,$4,$5)`,[orgId,entryId,byCode.get('2990'),amount,dto.memberId,byCode.get('1000')]);
          await this.mark(c,orgId,transactionId,{status:'MATCHED',memberId:dto.memberId,journalEntryId:posting.journalEntryId});
          await c.query(`INSERT INTO audit_logs (organization_id,actor_user_id,action,entity_type,entity_id,metadata)
            VALUES ($1,$2,'payment.allocated','provider_transaction',$3,$4::jsonb)`,
            [orgId,actorUserId,transactionId,JSON.stringify({memberId:dto.memberId,purpose,entryId,journalEntryId:posting.journalEntryId,amount})]);
          return {allocated:true,transactionId,entryId,journalEntryId:posting.journalEntryId,
            target:purpose==='LOAN_REPAYMENT'?'1020':purpose==='SHARE_PURCHASE'?'3000':'2000'};
        },c);
    });
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
