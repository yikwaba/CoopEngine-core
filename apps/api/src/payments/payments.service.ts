import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { ReconciliationService } from './reconciliation.service';

const DEV_SECRET = 'monnify-dev-secret';
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface VirtualAccountRow {
  id: string;
  memberId: string;
  memberNo: number;
  member: string;
  provider: string;
  accountReference: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  status: string;
  createdAt: Date;
}

interface MonnifyReservedAccountResponse {
  requestSuccessful?: boolean;
  responseBody?: {
    accountReference: string;
    accountNumber: string;
    bankName: string;
    accountName: string;
    [k: string]: unknown;
  };
}

@Injectable()
export class PaymentsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool,
    private readonly reconciliation: ReconciliationService,
  ) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  private get provider(): 'monnify' | 'dev' {
    return (process.env.MONNIFY_PROVIDER ?? 'dev').toLowerCase() === 'monnify'
      ? 'monnify'
      : 'dev';
  }

  private get secretKey(): string {
    return process.env.MONNIFY_SECRET_KEY ?? DEV_SECRET;
  }

  /**
   * Create a reserved (virtual) account for an ACTIVE member.
   * `dev` provider mints a local account; `monnify` calls the real API
   * (requires MONNIFY_API_KEY + MONNIFY_SECRET_KEY + MONNIFY_CONTRACT_CODE).
   */
  async createVirtualAccount(
    organizationId: string | null,
    memberId: string,
  ): Promise<VirtualAccountRow> {
    const orgId = this.requireOrg(organizationId);
    const accountRef = `VA-${orgId.slice(0, 8)}-${memberId.slice(0, 8)}`;
    const result = await withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(
        `SELECT id, first_name, last_name, status FROM members
          WHERE organization_id = $1 AND id = $2`,
        [orgId, memberId],
      );
      const m = member.rows[0] as
        | { id: string; first_name: string; last_name: string; status: string }
        | undefined;
      if (!m) throw new NotFoundException('Member not found');
      if (m.status !== 'ACTIVE') {
        throw new BadRequestException('Virtual accounts require an ACTIVE member');
      }
      const existing = await c.query(
        `SELECT 1 FROM member_virtual_accounts
          WHERE organization_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
        [orgId, memberId],
      );
      if (existing.rows[0]) {
        throw new ConflictException('Member already has an ACTIVE virtual account');
      }
      const fullName = `${m.first_name} ${m.last_name}`;
      let accountNumber: string;
      let bankName: string;
      let providerAccountRef = accountRef;
      if (this.provider === 'monnify') {
        const remote = await this.monnifyReserveAccount(orgId, memberId, fullName);
        accountNumber = remote.accountNumber;
        bankName = remote.bankName;
        providerAccountRef = remote.accountReference;
      } else {
        accountNumber = `8${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
        bankName = 'Dev Bank';
      }
      // Guard against (extremely unlikely) collisions
      const collision = await c.query(
        `SELECT 1 FROM member_virtual_accounts
          WHERE organization_id = $1 AND account_number = $2`,
        [orgId, accountNumber],
      );
      if (collision.rows[0]) {
        throw new ConflictException('Account number collision — retry');
      }
      const id = randomUUID();
      try {
        await c.query(
          `INSERT INTO member_virtual_accounts
             (id, organization_id, member_id, provider, account_reference, account_number, account_name, bank_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, orgId, memberId, this.provider, providerAccountRef, accountNumber, fullName, bankName],
        );
        await c.query(
          `INSERT INTO virtual_account_lookups (account_number, organization_id, member_id)
           VALUES ($1, $2, $3)`,
          [accountNumber, orgId, memberId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException(
            'Account number is already registered to another member — retry',
          );
        }
        throw err;
      }
      return {
        id,
        memberId,
        memberNo: Number((await c.query(
          `SELECT member_no FROM members WHERE organization_id = $1 AND id = $2`,
          [orgId, memberId],
        )).rows[0].member_no),
        member: fullName,
        provider: this.provider,
        accountReference: providerAccountRef,
        accountNumber,
        accountName: fullName,
        bankName,
        status: 'ACTIVE',
        createdAt: new Date(),
      };
    });
    return result;
  }

  async listVirtualAccounts(organizationId: string | null): Promise<VirtualAccountRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT v.id, v.member_id, m.member_no,
                m.first_name || ' ' || m.last_name AS member,
                v.provider, v.account_reference, v.account_number,
                v.account_name, v.bank_name, v.status, v.created_at
           FROM member_virtual_accounts v
           JOIN members m ON m.id = v.member_id
          WHERE v.organization_id = $1
          ORDER BY v.created_at DESC`,
        [orgId],
      );
      return rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        memberId: r.member_id as string,
        memberNo: Number(r.member_no),
        member: r.member as string,
        provider: r.provider as string,
        accountReference: r.account_reference as string,
        accountNumber: r.account_number as string,
        accountName: r.account_name as string,
        bankName: r.bank_name as string,
        status: r.status as string,
        createdAt: r.created_at as Date,
      }));
    });
  }

  /** Monnify webhook: verify signature, dedupe, auto-post to the ledger. */
  async handleWebhook(
    payload: Record<string, unknown>,
    rawBody: string | undefined,
    signature?: string,
  ): Promise<{
    acknowledged: boolean;
    paymentReference?: string;
    matched?: boolean;
    exception?: boolean;
    reason?: string;
  }> {
    const accountNumber = String(payload.accountNumber ?? '');
    const paymentReference = String(payload.paymentReference ?? '');
    const transactionReference = String(payload.transactionReference ?? '');
    const amount = Number(payload.amountPaid ?? payload.amount ?? NaN);
    const paidAt = payload.paymentDate ? new Date(String(payload.paymentDate)) : new Date();
    const status = String(payload.transactionStatus ?? '');

    if (!accountNumber || !paymentReference || !Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Malformed payment notification');
    }
    if (status !== 'SUCCESSFUL' && status !== '') {
      // Explicit non-success statuses are acknowledged but never posted.
      return { acknowledged: true, paymentReference };
    }

    // Signature: SHA-512(secretKey + "|" + rawBody) — Monnify's scheme.
    const signedPayload = rawBody ?? JSON.stringify(payload);
    const hash = createHash('sha512').update(`${this.secretKey}|${signedPayload}`).digest('hex');
    const provided = (signature ?? '').toLowerCase();
    if (!provided || hash !== provided) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const lookup = await this.pool.query(
      `SELECT organization_id, member_id FROM virtual_account_lookups
        WHERE account_number = $1 LIMIT 1`,
      [accountNumber],
    );
    if (!lookup.rows[0]) {
      // Unknown account — acknowledge silently (never leak account existence).
      return { acknowledged: false, paymentReference };
    }
    const orgRow = lookup.rows[0] as { organization_id: string; member_id: string };
    const orgId = orgRow.organization_id;
    const memberId = orgRow.member_id;
    const accountRef = String(payload.accountReference ?? '');

    // Hand the receipt to the reconciliation engine rather than posting it here. It resolves the
    // member, honours any payment intent the member quoted, posts through the same services the
    // counter uses, and parks anything unresolved in Unallocated Receipts. Keeping one posting
    // path is what stops two of them disagreeing about what a member is owed.
    const outcome: { matched: boolean; exception?: boolean; reason?: string } =
      await this.reconciliation.recordTransaction(orgId, null, {
      provider: 'MONNIFY',
      providerReference: transactionReference || paymentReference,
      amount: round2(amount),
      payerName: String(payload.payerName ?? payload.customerName ?? '') || undefined,
      payerAccount: String(payload.payerAccountNumber ?? '') || undefined,
      narration: `${accountRef} ${String(payload.paymentDescription ?? '')}`.trim(),
      virtualAccountNo: accountNumber,
      receivedAt: paidAt.toISOString(),
      raw: payload,
    });

    // Keep the provider's own record of what it told us, exactly as it told us: a reconciliation
    // engine is only as good as the evidence behind it, and this is the evidence.
    await withTenant(this.pool, orgId, async (c) => {
      await c.query(
        `INSERT INTO payment_notifications
           (organization_id, member_id, account_reference, account_number, payment_reference,
            transaction_reference, amount, paid_at, status, journal_entry_id, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          orgId,
          memberId,
          accountRef || accountNumber,
          accountNumber,
          paymentReference,
          transactionReference || paymentReference,
          String(round2(amount)),
          paidAt,
          outcome.matched ? 'POSTED' : 'FAILED',
          (outcome as { journalEntryId?: string }).journalEntryId ?? null,
          JSON.stringify(payload),
        ],
      );
    });

    return { acknowledged: true, paymentReference, ...outcome };
  }

  async listNotifications(
    organizationId: string | null,
    accountNumber?: string,
    limit = 100,
    offset = 0,
  ): Promise<{
    total: number;
    items: {
      id: string;
      accountNumber: string;
      memberId: string;
      paymentReference: string;
      transactionReference: string;
      amount: number;
      paidAt: Date;
      status: string;
    }[];
  }> {
    const orgId = this.requireOrg(organizationId);
    const n = Math.min(Math.max(Number.isFinite(Number(limit)) ? Number(limit) : 100, 1), 500);
    const off = Math.max(offset, 0);
    return withTenant(this.pool, orgId, async (c) => {
      const whereClause = `organization_id = $1${accountNumber ? ' AND account_number = $2' : ''}`;
      const params = accountNumber ? [orgId, accountNumber] : [orgId];
      const { rows } = await c.query(
        `SELECT id, account_number, member_id, payment_reference,
                transaction_reference, amount, paid_at, status
           FROM payment_notifications
          WHERE ${whereClause}
          ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, n, off],
      );
      const count = await c.query(
        `SELECT count(*)::int AS n FROM payment_notifications
          WHERE organization_id = $1 ${accountNumber ? 'AND account_number = $2' : ''}`,
        accountNumber ? [orgId, accountNumber] : [orgId],
      );
      return {
        total: (count.rows[0] as { n: number }).n,
        items: rows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          accountNumber: r.account_number as string,
          memberId: r.member_id as string,
          paymentReference: r.payment_reference as string,
          transactionReference: r.transaction_reference as string,
          amount: Number(r.amount),
          paidAt: r.paid_at as Date,
          status: r.status as string,
        })),
      };
    });
  }

  /** fetch with a bounded timeout for provider calls. */
  private async monnifyFetch(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = Number(process.env.MONNIFY_TIMEOUT_MS ?? 10_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[monnify] request error: ${err instanceof Error ? err.name : 'unknown'}`,
      );
      throw new BadRequestException('Monnify request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private async monnifyReserveAccount(
    orgId: string,
    memberId: string,
    accountName: string,
  ): Promise<{ accountReference: string; accountNumber: string; bankName: string }> {
    const apiKey = process.env.MONNIFY_API_KEY;
    const secretKey = process.env.MONNIFY_SECRET_KEY;
    const contractCode = process.env.MONNIFY_CONTRACT_CODE;
    const baseUrl = process.env.MONNIFY_BASE_URL ?? 'https://sandbox.monnify.com';
    if (!apiKey || !secretKey || !contractCode) {
      throw new BadRequestException(
        'MONNIFY_PROVIDER=monnify requires MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE',
      );
    }
    const authRes = await this.monnifyFetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST', // Monnify requires POST for the auth/login endpoint
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}` },
    });
    const authBody = (await authRes.json()) as { requestSuccessful?: boolean; responseBody?: { accessToken?: string } };
    const token = authBody.responseBody?.accessToken;
    if (!authRes.ok || !token) {
      throw new BadRequestException('Monnify authentication failed');
    }
    const reserveRes = await this.monnifyFetch(`${baseUrl}/api/v1/bank-transfer/reserved-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        accountReference: `CE-${orgId.slice(0, 8)}-${memberId.slice(0, 8)}`,
        accountName,
        currencyCode: 'NGN',
        contractCode,
        customerEmail: 'member@coopengine.app',
        getAllAvailableBanks: false,
        preferredBanks: [],
      }),
    });
    const body = (await reserveRes.json()) as MonnifyReservedAccountResponse;
    const rb = body.responseBody;
    if (!reserveRes.ok || !rb?.accountNumber) {
      throw new BadRequestException('Monnify reserved-account creation failed');
    }
    return {
      accountReference: rb.accountReference,
      accountNumber: rb.accountNumber,
      bankName: rb.bankName,
    };
  }
}
