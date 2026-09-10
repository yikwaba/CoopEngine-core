import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { AuthPrincipal } from '../common/auth.types';

type ProductKind = 'savings' | 'loan';

interface SavingsProductInput {
  code: string;
  name: string;
  interestRatePa: number;
  minDeposit: number;
  allowWithdrawal: boolean;
}

interface LoanProductInput {
  code: string;
  name: string;
  interestRatePa: number;
  interestMethod: 'FLAT' | 'REDUCING';
  multiplier: number;
  minPrincipal: number;
  maxPrincipal: number | null;
}

export interface SavingsProductRow {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  minDeposit: number;
  allowWithdrawal: boolean;
  status: string;
  accountCount: number;
}

export interface LoanProductRow {
  id: string;
  code: string;
  name: string;
  interestRatePa: number;
  interestMethod: string;
  multiplier: number;
  minPrincipal: number;
  maxPrincipal: number | null;
  status: string;
  loanCount: number;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  /** Savings products with usage counts (active accounts). */
  async listSavings(organizationId: string | null): Promise<SavingsProductRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.code, p.name, p.interest_rate_pa, p.min_deposit,
                p.allow_withdrawal, p.status,
                (SELECT count(*) FROM member_savings_accounts a
                  WHERE a.product_id = p.id AND a.status = 'ACTIVE') AS account_count
           FROM savings_products p
          ORDER BY p.code`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        code: r.code as string,
        name: r.name as string,
        interestRatePa: Number(r.interest_rate_pa),
        minDeposit: Number(r.min_deposit),
        allowWithdrawal: Boolean(r.allow_withdrawal),
        status: r.status as string,
        accountCount: Number(r.account_count),
      }));
    });
  }

  /** Loan products with usage counts (non-rejected loans). */
  async listLoans(organizationId: string | null): Promise<LoanProductRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.code, p.name, p.interest_rate_pa, p.interest_method,
                p.multiplier, p.min_principal, p.max_principal, p.status,
                (SELECT count(*) FROM loans l
                  WHERE l.loan_product_id = p.id AND l.status <> 'REJECTED') AS loan_count
           FROM loan_products p
          ORDER BY p.code`,
      );
      return rows.map((r) => ({
        id: r.id as string,
        code: r.code as string,
        name: r.name as string,
        interestRatePa: Number(r.interest_rate_pa),
        interestMethod: r.interest_method as string,
        multiplier: Number(r.multiplier),
        minPrincipal: Number(r.min_principal),
        maxPrincipal: r.max_principal === null ? null : Number(r.max_principal),
        status: r.status as string,
        loanCount: Number(r.loan_count),
      }));
    });
  }

  private validateSavings(input: SavingsProductInput): void {
    if (input.interestRatePa < 0 || input.interestRatePa > 100) {
      throw new BadRequestException('interestRatePa must be between 0 and 100');
    }
    if (input.minDeposit < 0) throw new BadRequestException('minDeposit cannot be negative');
  }

  private validateLoan(input: LoanProductInput): void {
    if (input.interestRatePa < 0 || input.interestRatePa > 100) {
      throw new BadRequestException('interestRatePa must be between 0 and 100');
    }
    if (input.multiplier <= 0 || input.multiplier > 10) {
      throw new BadRequestException('multiplier must be between 0 and 10');
    }
    if (input.minPrincipal < 0) throw new BadRequestException('minPrincipal cannot be negative');
    if (input.maxPrincipal !== null && input.maxPrincipal < input.minPrincipal) {
      throw new BadRequestException('maxPrincipal must be >= minPrincipal');
    }
  }

  async createSavings(
    organizationId: string | null,
    user: AuthPrincipal | null,
    input: SavingsProductInput,
  ): Promise<{ id: string }> {
    const orgId = this.requireOrg(organizationId);
    this.validateSavings(input);
    return withTenant(this.pool, orgId, async (c) => {
      const dup = await c.query(
        `SELECT 1 FROM savings_products WHERE lower(code) = lower($1)`,
        [input.code],
      );
      if (dup.rows.length > 0) throw new ConflictException('Product code already exists');
      const id = randomUUID();
      await c.query(
        `INSERT INTO savings_products
           (id, organization_id, code, name, interest_rate_pa, min_deposit, allow_withdrawal, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [id, orgId, input.code, input.name, String(input.interestRatePa),
         String(input.minDeposit), input.allowWithdrawal],
      );
      await this.audit(c, orgId, user, 'product.created', 'savings_product', id, input);
      return { id };
    });
  }

  async updateSavings(
    organizationId: string | null,
    user: AuthPrincipal | null,
    id: string,
    input: SavingsProductInput,
  ): Promise<{ id: string }> {
    const orgId = this.requireOrg(organizationId);
    this.validateSavings(input);
    return withTenant(this.pool, orgId, async (c) => {
      const cur = await c.query(`SELECT code FROM savings_products WHERE id = $1`, [id]);
      if (cur.rows.length === 0) throw new NotFoundException('Savings product not found');
      const dup = await c.query(
        `SELECT 1 FROM savings_products WHERE lower(code) = lower($1) AND id <> $2`,
        [input.code, id],
      );
      if (dup.rows.length > 0) throw new ConflictException('Product code already exists');
      await c.query(
        `UPDATE savings_products
            SET code = $2, name = $3, interest_rate_pa = $4, min_deposit = $5,
                allow_withdrawal = $6, updated_at = now()
          WHERE id = $1`,
        [id, input.code, input.name, String(input.interestRatePa),
         String(input.minDeposit), input.allowWithdrawal],
      );
      await this.audit(c, orgId, user, 'product.updated', 'savings_product', id, input);
      return { id };
    });
  }

  async createLoan(
    organizationId: string | null,
    user: AuthPrincipal | null,
    input: LoanProductInput,
  ): Promise<{ id: string }> {
    const orgId = this.requireOrg(organizationId);
    this.validateLoan(input);
    return withTenant(this.pool, orgId, async (c) => {
      const dup = await c.query(`SELECT 1 FROM loan_products WHERE lower(code) = lower($1)`, [input.code]);
      if (dup.rows.length > 0) throw new ConflictException('Product code already exists');
      const id = randomUUID();
      await c.query(
        `INSERT INTO loan_products
           (id, organization_id, code, name, interest_rate_pa, interest_method,
            multiplier, min_principal, max_principal, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')`,
        [id, orgId, input.code, input.name, String(input.interestRatePa), input.interestMethod,
         String(input.multiplier), String(input.minPrincipal),
         input.maxPrincipal === null ? null : String(input.maxPrincipal)],
      );
      await this.audit(c, orgId, user, 'product.created', 'loan_product', id, input);
      return { id };
    });
  }

  async updateLoan(
    organizationId: string | null,
    user: AuthPrincipal | null,
    id: string,
    input: LoanProductInput,
  ): Promise<{ id: string }> {
    const orgId = this.requireOrg(organizationId);
    this.validateLoan(input);
    return withTenant(this.pool, orgId, async (c) => {
      const cur = await c.query(`SELECT code FROM loan_products WHERE id = $1`, [id]);
      if (cur.rows.length === 0) throw new NotFoundException('Loan product not found');
      const dup = await c.query(
        `SELECT 1 FROM loan_products WHERE lower(code) = lower($1) AND id <> $2`,
        [input.code, id],
      );
      if (dup.rows.length > 0) throw new ConflictException('Product code already exists');
      await c.query(
        `UPDATE loan_products
            SET code = $2, name = $3, interest_rate_pa = $4, interest_method = $5,
                multiplier = $6, min_principal = $7, max_principal = $8, updated_at = now()
          WHERE id = $1`,
        [id, input.code, input.name, String(input.interestRatePa), input.interestMethod,
         String(input.multiplier), String(input.minPrincipal),
         input.maxPrincipal === null ? null : String(input.maxPrincipal)],
      );
      await this.audit(c, orgId, user, 'product.updated', 'loan_product', id, input);
      return { id };
    });
  }

  /**
   * Activate/deactivate a product. Deactivation is blocked while the product is
   * in active use (open savings accounts / non-rejected loans).
   */
  async setStatus(
    organizationId: string | null,
    user: AuthPrincipal | null,
    kind: ProductKind,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
  ): Promise<{ id: string; status: string }> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const table = kind === 'savings' ? 'savings_products' : 'loan_products';
      const cur = await c.query(`SELECT status FROM ${table} WHERE id = $1`, [id]);
      if (cur.rows.length === 0) throw new NotFoundException('Product not found');
      if (status === 'INACTIVE') {
        const usage =
          kind === 'savings'
            ? await c.query(
                `SELECT count(*) AS n FROM member_savings_accounts
                  WHERE product_id = $1 AND status = 'ACTIVE'`,
                [id],
              )
            : await c.query(
                `SELECT count(*) AS n FROM loans
                  WHERE loan_product_id = $1 AND status <> 'REJECTED'`,
                [id],
              );
        if (Number(usage.rows[0].n) > 0) {
          throw new ConflictException('Product is in use; cannot deactivate');
        }
      }
      await c.query(`UPDATE ${table} SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
      await this.audit(c, orgId, user, `product.status.${status.toLowerCase()}`, `${kind}_product`, id, {
        status,
      });
      return { id, status };
    });
  }

  private async audit(
    c: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    organizationId: string,
    user: AuthPrincipal | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: unknown,
  ): Promise<void> {
    await c.query(
      `INSERT INTO audit_logs
         (id, organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        organizationId,
        user?.userId ?? null,
        action,
        entityType,
        entityId,
        JSON.stringify(metadata),
      ],
    );
  }
}

