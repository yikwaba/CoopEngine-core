/**
 * Co-opEngine database schema (Drizzle ORM, PostgreSQL).
 *
 * Conventions (Technical Implementation Plan §3–§4):
 * - Every table: `id uuid PK DEFAULT gen_random_uuid()`, created_at/updated_at.
 * - Every tenant-owned table carries `organization_id` and is RLS-protected.
 * - Money is NUMERIC(19,2) — never float.
 * - RLS policy shape: `tenant_isolation` using the transaction-local GUC
 *   `app.tenant_id` (defense in depth — see ADR-0003).
 *
 * Phase 1A baseline: tenancy (organizations, settings, branches), audit_logs.
 */

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Transaction-local tenant GUC set by the app for every tenant-scoped request. */
export const TENANT_GUC = 'app.tenant_id';

/** Policy predicate: row belongs to the current tenant context. */
const tenantScope = (orgColumn: unknown) =>
  sql`${orgColumn} = nullif(current_setting('app.tenant_id', true), '')::uuid`;

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    legalName: varchar('legal_name', { length: 255 }),
    slug: varchar('slug', { length: 80 }).notNull().unique(),
    subdomain: varchar('subdomain', { length: 80 }).unique(),
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** NULL = no approval needed; 0 = always; N = above N (see savings_withdrawal_requests). */
    withdrawalApprovalThreshold: numeric('withdrawal_approval_threshold', { precision: 19, scale: 2 }),
  },
  (table) => [
    pgPolicy('tenant_self_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.id),
      withCheck: tenantScope(table.id),
    }),
  ],
);

/** Per-tenant running counters (e.g. member_no) — row-locked increments. */
export const orgCounters = pgTable(
  'org_counters',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberSeq: bigint('member_seq', { mode: 'number' })
      .notNull()
      .default(0),
    journalSeq: bigint('journal_seq', { mode: 'number' })
      .notNull()
      .default(0),
    savingsSeq: bigint('savings_seq', { mode: 'number' })
      .notNull()
      .default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberNo: bigint('member_no', { mode: 'number' }).notNull(),
    firstName: varchar('first_name', { length: 120 }).notNull(),
    lastName: varchar('last_name', { length: 120 }).notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    gender: varchar('gender', { length: 16 }),
    dateOfBirth: date('date_of_birth'),
    status: text('status').notNull().default('PENDING'),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('members_org_status_idx').on(table.organizationId, table.status),
    uniqueIndex('members_org_member_no_uq').on(
      table.organizationId,
      table.memberNo,
    ),
  ],
);

export const nextOfKin = pgTable(
  'next_of_kin',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    relationship: varchar('relationship', { length: 64 }),
    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 320 }),
    address: text('address'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('next_of_kin_org_member_idx').on(
      table.organizationId,
      table.memberId,
    ),
  ],
);

/** Chart of accounts (per tenant). Codes unique within the tenant. */
export const chartOfAccounts = pgTable(
  'chart_of_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 16 }).notNull(),
    name: varchar('name', { length: 180 }).notNull(),
    type: varchar('type', { length: 16 }).notNull(), // ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
    category: varchar('category', { length: 80 }),
    parentId: uuid('parent_id').references((): any => chartOfAccounts.id, {
      onDelete: 'set null',
    }),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('coa_org_code_uq').on(table.organizationId, table.code),
  ],
);

/** Accounting periods: OPEN -> SOFT_CLOSED -> LOCKED (per tenant). */
export const ledgerPeriods = pgTable(
  'ledger_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 7 }).notNull(), // YYYY-MM
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').notNull().default('OPEN'), // OPEN|SOFT_CLOSED|LOCKED
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('ledger_periods_org_code_uq').on(
      table.organizationId,
      table.code,
    ),
  ],
);

/**
 * Journal entries (append-only): DRAFT -> SUBMITTED -> POSTED -> REVERSED.
 * Never edited after posting; reversals create linked opposite entries.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    periodId: uuid('period_id')
      .notNull()
      .references(() => ledgerPeriods.id),
    entryNo: bigint('entry_no', { mode: 'number' }), // allocated on POST
    entryDate: date('entry_date').notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    source: varchar('source', { length: 40 }).notNull().default('MANUAL'),
    sourceType: varchar('source_type', { length: 40 }),
    sourceId: uuid('source_id'),
    status: text('status').notNull().default('DRAFT'), // DRAFT|SUBMITTED|POSTED|REVERSED
    idempotencyKey: varchar('idempotency_key', { length: 100 }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    postedBy: uuid('posted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversalOfEntryId: uuid('reversal_of_entry_id').references(
      (): any => journalEntries.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('journal_entries_org_no_uq')
      .on(table.organizationId, table.entryNo)
      .where(sql`${table.entryNo} IS NOT NULL`),
    index('journal_entries_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
    index('journal_entries_org_date_idx').on(
      table.organizationId,
      table.entryDate,
    ),
  ],
);

/** Journal lines: single-sided debits/credits, balanced per entry. */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccounts.id),
    debit: numeric('debit', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    credit: numeric('credit', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    memo: varchar('memo', { length: 255 }),
    memberId: uuid('member_id').references(() => members.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('journal_lines_entry_idx').on(table.journalEntryId),
  ],
);

/** Savings products (per tenant), e.g. Regular Savings. */
export const savingsProducts = pgTable(
  'savings_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    interestRatePa: numeric('interest_rate_pa', {
      precision: 7,
      scale: 4,
    })
      .notNull()
      .default('0'),
    minDeposit: numeric('min_deposit', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    allowWithdrawal: boolean('allow_withdrawal').notNull().default(true),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('savings_products_org_code_uq').on(
      table.organizationId,
      table.code,
    ),
  ],
);

/** Member savings accounts — one per (member, product) per tenant. */
export const memberSavingsAccounts = pgTable(
  'member_savings_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => savingsProducts.id),
    accountNo: bigint('account_no', { mode: 'number' }).notNull(),
    currentBalance: numeric('current_balance', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    status: text('status').notNull().default('ACTIVE'),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('savings_accounts_org_no_uq').on(
      table.organizationId,
      table.accountNo,
    ),
    uniqueIndex('savings_accounts_member_product_uq').on(
      table.organizationId,
      table.memberId,
      table.productId,
    ),
  ],
);

/**
 * Savings transaction projection (append-only). The JOURNAL is the source
 * of truth; this table keeps member statements and running balances fast.
 * Written in the same transaction as the posting.
 */
export const savingsTransactions = pgTable(
  'savings_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => memberSavingsAccounts.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    type: varchar('type', { length: 24 }).notNull(), // DEPOSIT|WITHDRAWAL|INTEREST|FEE|DIVIDEND|OPENING_BALANCE
    signedAmount: numeric('signed_amount', { precision: 19, scale: 2 })
      .notNull(),
    runningBalance: numeric('running_balance', { precision: 19, scale: 2 })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('savings_txn_account_time_idx').on(
      table.accountId,
      table.createdAt,
    ),
  ],
);

/** Loan products (per tenant). Rate/interest method snapshotted on the loan. */
export const loanProducts = pgTable(
  'loan_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    interestRatePa: numeric('interest_rate_pa', {
      precision: 7,
      scale: 4,
    })
      .notNull()
      .default('0'),
    interestMethod: varchar('interest_method', { length: 16 })
      .notNull()
      .default('FLAT'), // FLAT | REDUCING
    multiplier: numeric('multiplier', { precision: 5, scale: 2 })
      .notNull()
      .default('3'),
    minPrincipal: numeric('min_principal', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    maxPrincipal: numeric('max_principal', { precision: 19, scale: 2 }),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('loan_products_org_code_uq').on(
      table.organizationId,
      table.code,
    ),
  ],
);

/** Loan applications with lifecycle state machine (PRD §13). */
export const loans = pgTable(
  'loans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    loanProductId: uuid('loan_product_id')
      .notNull()
      .references(() => loanProducts.id),
    principal: numeric('principal', { precision: 19, scale: 2 }).notNull(),
    termMonths: bigint('term_months', { mode: 'number' }).notNull(),
    // Rate snapshot at application time (product rates may change later).
    interestRatePa: numeric('interest_rate_pa', {
      precision: 7,
      scale: 4,
    }).notNull(),
    interestMethod: varchar('interest_method', { length: 16 })
      .notNull()
      .default('FLAT'),
    status: text('status').notNull().default('PENDING'), // PENDING|APPROVED|REJECTED|DISBURSED|COMPLETED|DEFAULTED
    outstandingPrincipal: numeric('outstanding_principal', {
      precision: 19,
      scale: 2,
    })
      .notNull()
      .default('0'),
    rejectionReason: varchar('rejection_reason', { length: 255 }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedBy: uuid('approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    disbursedBy: uuid('disbursed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    disbursedAt: timestamp('disbursed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('loans_org_status_idx').on(table.organizationId, table.status),
    index('loans_org_member_idx').on(table.organizationId, table.memberId),
  ],
);

/** Loan guarantors (min 2 per application; PRD §13). */
export const loanGuarantors = pgTable(
  'loan_guarantors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('PENDING'), // PENDING|APPROVED|REJECTED
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('loan_guarantors_uq').on(table.loanId, table.memberId),
  ],
);

/** Loan repayment schedule — one row per installment (generated on disbursement). */
export const loanRepayments = pgTable(
  'loan_repayments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    dueDate: date('due_date').notNull(),
    principalDue: numeric('principal_due', { precision: 19, scale: 2 }).notNull(),
    interestDue: numeric('interest_due', { precision: 19, scale: 2 }).notNull(),
    paidPrincipal: numeric('paid_principal', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    paidInterest: numeric('paid_interest', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    status: text('status').notNull().default('PENDING'), // PENDING|PARTIAL|PAID (OVERDUE derived)
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('loan_repayments_loan_seq_uq').on(table.loanId, table.seq),
  ],
);

/** Member share capital accounts — one per member per tenant. */
export const memberShareAccounts = pgTable(
  'member_share_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    currentBalance: numeric('current_balance', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    status: text('status').notNull().default('ACTIVE'),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('member_share_accounts_org_member_uq').on(
      table.organizationId,
      table.memberId,
    ),
  ],
);

/** Share purchase projection (append-only; journal is source of truth). */
export const shareTransactions = pgTable(
  'share_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => memberShareAccounts.id, { onDelete: 'cascade' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    type: varchar('type', { length: 24 }).notNull().default('PURCHASE'),
    signedAmount: numeric('signed_amount', { precision: 19, scale: 2 })
      .notNull(),
    runningBalance: numeric('running_balance', { precision: 19, scale: 2 })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('share_txn_account_time_idx').on(table.accountId, table.createdAt),
  ],
);

/** Bulk payroll-deduction batches (preview -> commit; FR-020). */
export const payrollBatches = pgTable(
  'payroll_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    kind: varchar('kind', { length: 24 }).notNull().default('PAYROLL'), // PAYROLL|SHARE_PURCHASE|LOAN_REPAYMENT
    status: text('status').notNull().default('PENDING'), // PENDING|PREVIEWED|COMMITTED
    totalRows: bigint('total_rows', { mode: 'number' }).notNull().default(0),
    validRows: bigint('valid_rows', { mode: 'number' }).notNull().default(0),
    invalidCount: bigint('invalid_count', { mode: 'number' })
      .notNull()
      .default(0),
    rows: jsonb('rows'),
    totalAmount: numeric('total_amount', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    committedBy: uuid('committed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/**
 * Public org resolver (NO RLS by design): lets pre-auth flows (member OTP,
 * future signup) resolve a slug to an organization id without a tenant
 * context. Populated transactionally at onboarding.
 */
export const orgLookups = pgTable('org_lookups', {
  slug: varchar('slug', { length: 80 }).primaryKey(),
  organizationId: uuid('organization_id').notNull().unique(),
});

/** Member OTP login codes (tenant-scoped; hashed at rest, 10-min TTL). */
export const memberOtps = pgTable(
  'member_otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('member_otps_member_created_idx').on(table.memberId, table.createdAt),
  ],
);

/** Savings interest period-end postings (one per org+period). */
export const savingsInterestPostings = pgTable(
  'savings_interest_postings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    periodCode: varchar('period_code', { length: 7 }).notNull(), // YYYY-MM
    totalAmount: numeric('total_amount', { precision: 19, scale: 2 })
      .notNull()
      .default('0'),
    entryId: uuid('entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    postedBy: uuid('posted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    postedAt: timestamp('posted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('interest_postings_org_period_uq').on(
      table.organizationId,
      table.periodCode,
    ),
  ],
);

/**
 /** Member savings goals (target amount + optional target date). */
export const savingsGoals = pgTable(
  'savings_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    targetAmount: numeric('target_amount', { precision: 19, scale: 2 }).notNull(),
    targetDate: date('target_date'),
    startingBalance: numeric('starting_balance', { precision: 19, scale: 2 }).notNull(),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE|ACHIEVED|CANCELLED
    achievedAt: timestamp('achieved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/** Standing contribution instructions (recorded mandates, reminder-driven). */
export const standingInstructions = pgTable(
  'standing_instructions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 19, scale: 2 }).notNull(),
    frequency: text('frequency').notNull().default('MONTHLY'), // WEEKLY|MONTHLY
    nextRunDate: date('next_run_date').notNull(),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE|PAUSED|CANCELLED
    note: varchar('note', { length: 255 }),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/**
 * Maker-checker control for savings withdrawals.
 *
 * The organisation setting `withdrawal_approval_threshold` decides the policy:
 *   NULL  -> no approval needed (withdrawals post immediately)
 *   0     -> every withdrawal needs a second pair of eyes
 *   N > 0 -> withdrawals above N need approval
 */
export const savingsWithdrawalRequests = pgTable(
  'savings_withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => memberSavingsAccounts.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 19, scale: 2 }).notNull(),
    description: varchar('description', { length: 240 }),
    status: text('status').notNull().default('PENDING'), // PENDING|APPROVED|REJECTED|CANCELLED
    source: text('source').notNull().default('STAFF'), // STAFF|MEMBER
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestedByMemberId: uuid('requested_by_member_id').references(() => members.id, {
      onDelete: 'set null',
    }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNotes: varchar('decision_notes', { length: 240 }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/** Bulk migration of a cooperative's existing balances onto the platform. */
export const openingBalanceBatches = pgTable(
  'opening_balance_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 120 }).notNull(),
    sourceFilename: varchar('source_filename', { length: 255 }),
    status: text('status').notNull().default('PENDING'), // PENDING|POSTED|VOID
    memberCount: integer('member_count').notNull().default(0),
    savingsTotal: numeric('savings_total', { precision: 19, scale: 2 }).notNull().default('0'),
    sharesTotal: numeric('shares_total', { precision: 19, scale: 2 }).notNull().default('0'),
    loansTotal: numeric('loans_total', { precision: 19, scale: 2 }).notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

export const openingBalanceRows = pgTable(
  'opening_balance_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => openingBalanceBatches.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    savingsAmount: numeric('savings_amount', { precision: 19, scale: 2 }).notNull().default('0'),
    sharesAmount: numeric('shares_amount', { precision: 19, scale: 2 }).notNull().default('0'),
    loanOutstanding: numeric('loan_outstanding', { precision: 19, scale: 2 }).notNull().default('0'),
    loanTermMonths: integer('loan_term_months'),
    loanRatePa: numeric('loan_rate_pa', { precision: 9, scale: 4 }),
    /** Days the legacy loan is already past due at cut-over. */
    loanDaysLate: integer('loan_days_late'),
    /** Overdue amount recorded by the old system (reference only). */
    loanArrearsAmount: numeric('loan_arrears_amount', { precision: 19, scale: 2 }),
    /** Instalments already paid in the old system — rebuilt as history rows. */
    loanPaidCount: integer('loan_paid_count').notNull().default(0),
    /** Original principal (optional; inferred from outstanding + paid count). */
    loanPrincipal: numeric('loan_principal', { precision: 19, scale: 2 }),
    /** Date of the most recent payment in the old system (recorded in the audit trail). */
    loanLastPaymentDate: date('loan_last_payment_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/** KYC / membership documents uploaded for a member. */
export const memberDocuments = pgTable(
  'member_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    docType: varchar('doc_type', { length: 32 }).notNull(), // ID_CARD|UTILITY_BILL|PASSPORT|SIGNATURE|OTHER
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storagePath: text('storage_path').notNull(),
    status: text('status').notNull().default('PENDING'), // PENDING|VERIFIED|REJECTED
    uploadedByMember: boolean('uploaded_by_member').notNull().default(false),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewNotes: text('review_notes'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/** Member / staff notification records (in-app, SMS, email). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 40 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    body: text('body').notNull(),
    channels: text('channels').array().notNull().default(['IN_APP']),
    status: text('status').notNull().default('PENDING'), // PENDING|SENT|FAILED
    sentAt: timestamp('sent_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    externalRef: varchar('external_ref', { length: 120 }),
    error: text('error'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

/** Dividend (surplus distribution) runs — one per org + period. */
 export const dividendRuns = pgTable(
   'dividend_runs',
   {
     id: uuid('id').primaryKey().defaultRandom(),
     organizationId: uuid('organization_id')
       .notNull()
       .references(() => organizations.id, { onDelete: 'cascade' }),
     periodLabel: varchar('period_label', { length: 16 }).notNull(), // e.g. '2026'
     distributableAmount: numeric('distributable_amount', { precision: 19, scale: 2 }).notNull(),
     status: text('status').notNull().default('POSTED'), // POSTED (preview is computed on the fly)
     journalEntryId: uuid('journal_entry_id'),
     memberCount: bigint('member_count', { mode: 'number' }).notNull().default(0),
     createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
   },
   (table) => [
     pgPolicy('tenant_isolation', {
       as: 'permissive',
       for: 'all',
       using: tenantScope(table.organizationId),
       withCheck: tenantScope(table.organizationId),
     }),
   ],
 );

 /** Per-member dividend allocation for a run. */
 export const dividendAllocations = pgTable(
   'dividend_allocations',
   {
     id: uuid('id').primaryKey().defaultRandom(),
     organizationId: uuid('organization_id')
       .notNull()
       .references(() => organizations.id, { onDelete: 'cascade' }),
     runId: uuid('run_id')
       .notNull()
       .references(() => dividendRuns.id, { onDelete: 'cascade' }),
     memberId: uuid('member_id')
       .notNull()
       .references(() => members.id, { onDelete: 'cascade' }),
     shareBalance: numeric('share_balance', { precision: 19, scale: 2 }).notNull(),
     amount: numeric('amount', { precision: 19, scale: 2 }).notNull(),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
   },
   (table) => [
     pgPolicy('tenant_isolation', {
       as: 'permissive',
       for: 'all',
       using: tenantScope(table.organizationId),
       withCheck: tenantScope(table.organizationId),
     }),
   ],
 );

 /** Public virtual-account resolver (NO RLS by design): lets unauthenticated
 * inbound payment webhooks resolve an account number to its organization
 * before any tenant context exists. Maintained transactionally on create.
 */
export const virtualAccountLookups = pgTable('virtual_account_lookups', {
  accountNumber: varchar('account_number', { length: 32 }).primaryKey(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Monnify/dev virtual accounts per member (payment collection rails). */
export const memberVirtualAccounts = pgTable(
  'member_virtual_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 16 }).notNull().default('dev'), // monnify|dev
    accountReference: varchar('account_reference', { length: 80 }).notNull(),
    accountNumber: varchar('account_number', { length: 32 }).notNull(),
    accountName: varchar('account_name', { length: 160 }).notNull(),
    bankName: varchar('bank_name', { length: 120 }).notNull(),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE|CLOSED
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('virtual_accounts_number_uq').on(table.organizationId, table.accountNumber),
    index('virtual_accounts_member_idx').on(table.memberId),
  ],
);

/** Inbound payment notifications (Monnify webhooks / dev simulators). */
export const paymentNotifications = pgTable(
  'payment_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    accountReference: varchar('account_reference', { length: 80 }).notNull(),
    accountNumber: varchar('account_number', { length: 32 }).notNull(),
    paymentReference: varchar('payment_reference', { length: 120 }).notNull(),
    transactionReference: varchar('transaction_reference', { length: 120 }).notNull(),
    amount: numeric('amount', { precision: 19, scale: 2 }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('POSTED'), // POSTED|FAILED
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),
    raw: jsonb('raw').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    uniqueIndex('payment_notifications_ref_uq').on(
      table.organizationId,
      table.paymentReference,
    ),
  ],
);

/** Bulk member-import batches: validated preview rows awaiting commit. */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    status: text('status').notNull().default('PENDING'),
    totalRows: bigint('total_rows', { mode: 'number' }).notNull().default(0),
    validRows: bigint('valid_rows', { mode: 'number' }).notNull().default(0),
    invalidRows: bigint('invalid_rows', { mode: 'number' })
      .notNull()
      .default(0),
    committedCount: bigint('committed_count', { mode: 'number' })
      .notNull()
      .default(0),
    rows: jsonb('rows').notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('import_batches_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const organizationSettings = pgTable(
  'organization_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    timezone: varchar('timezone', { length: 64 })
      .notNull()
      .default('Africa/Lagos'),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 32 }),
    isHeadquarters: boolean('is_headquarters').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('branches_org_idx').on(table.organizationId),
  ],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  passwordHash: text('password_hash'),
  status: text('status').notNull().default('ACTIVE'),
  mfaSecret: text('mfa_secret'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Login attempt tracking for rate limiting (email + IP windows). */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    ipAddress: text('ip_address').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('login_attempts_email_ip_time_idx').on(
      table.email,
      table.ipAddress,
      table.attemptedAt,
    ),
  ],
);

/**
 * Roles (org-scoped by default; `scope='saas'` roles are platform-global).
 * Role rows are NOT RLS-protected in this phase: they are read by the auth
 * service outside any tenant context (login/org listing) and guarded at the
 * application layer. Membership data remains the RLS-protected surface.
 */
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  scope: text('scope').notNull().default('org'),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 100 }).notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(
      () => organizations.id,
      { onDelete: 'cascade' },
    ),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('user_roles_user_org_idx').on(
      table.userId,
      table.organizationId,
    ),
  ],
);

/** Refresh-token sessions (rotating, revocable). */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
  ],
);

/**
 * Central audit log — deliberately NOT RLS-protected at DB level:
 * writes must never be blocked (system-level events have no tenant GUC),
 * and reads are guarded at the application layer (audit.view permission,
 * org scope in queries). See Technical Implementation Plan §13.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    actorUserId: uuid('actor_user_id'),
    action: varchar('action', { length: 120 }).notNull(),
    entityType: varchar('entity_type', { length: 80 }),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'),
    sessionId: text('session_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_logs_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    index('audit_logs_action_idx').on(table.action),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type NewOrganizationSettings = typeof organizationSettings.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type OrgCounter = typeof orgCounters.$inferSelect;
export type NewOrgCounter = typeof orgCounters.$inferInsert;
export type ChartOfAccount = typeof chartOfAccounts.$inferSelect;
export type NewChartOfAccount = typeof chartOfAccounts.$inferInsert;
export type LedgerPeriod = typeof ledgerPeriods.$inferSelect;
export type NewLedgerPeriod = typeof ledgerPeriods.$inferInsert;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
export type SavingsProduct = typeof savingsProducts.$inferSelect;
export type NewSavingsProduct = typeof savingsProducts.$inferInsert;
export type MemberSavingsAccount = typeof memberSavingsAccounts.$inferSelect;
export type NewMemberSavingsAccount = typeof memberSavingsAccounts.$inferInsert;
export type SavingsTransaction = typeof savingsTransactions.$inferSelect;
export type NewSavingsTransaction = typeof savingsTransactions.$inferInsert;
export type LoanProduct = typeof loanProducts.$inferSelect;
export type NewLoanProduct = typeof loanProducts.$inferInsert;
export type Loan = typeof loans.$inferSelect;
export type NewLoan = typeof loans.$inferInsert;
export type LoanGuarantor = typeof loanGuarantors.$inferSelect;
export type NewLoanGuarantor = typeof loanGuarantors.$inferInsert;
export type LoanRepayment = typeof loanRepayments.$inferSelect;
export type NewLoanRepayment = typeof loanRepayments.$inferInsert;
export type MemberShareAccount = typeof memberShareAccounts.$inferSelect;
export type NewMemberShareAccount = typeof memberShareAccounts.$inferInsert;
export type ShareTransaction = typeof shareTransactions.$inferSelect;
export type NewShareTransaction = typeof shareTransactions.$inferInsert;
export type PayrollBatch = typeof payrollBatches.$inferSelect;
export type NewPayrollBatch = typeof payrollBatches.$inferInsert;
export type OrgLookup = typeof orgLookups.$inferSelect;
export type MemberOtp = typeof memberOtps.$inferSelect;
export type NewMemberOtp = typeof memberOtps.$inferInsert;
export type SavingsInterestPosting = typeof savingsInterestPostings.$inferSelect;
export type NewSavingsInterestPosting = typeof savingsInterestPostings.$inferInsert;
export type MemberVirtualAccount = typeof memberVirtualAccounts.$inferSelect;
export type NewMemberVirtualAccount = typeof memberVirtualAccounts.$inferInsert;
export type PaymentNotification = typeof paymentNotifications.$inferSelect;
export type NewPaymentNotification = typeof paymentNotifications.$inferInsert;
export type VirtualAccountLookup = typeof virtualAccountLookups.$inferSelect;
export type SavingsGoal = typeof savingsGoals.$inferSelect;
export type StandingInstruction = typeof standingInstructions.$inferSelect;
export type SavingsWithdrawalRequest = typeof savingsWithdrawalRequests.$inferSelect;
export type OpeningBalanceBatch = typeof openingBalanceBatches.$inferSelect;
export type OpeningBalanceRow = typeof openingBalanceRows.$inferSelect;
export type MemberDocument = typeof memberDocuments.$inferSelect;
export type NewMemberDocument = typeof memberDocuments.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type DividendRun = typeof dividendRuns.$inferSelect;
export type NewDividendRun = typeof dividendRuns.$inferInsert;
export type DividendAllocation = typeof dividendAllocations.$inferSelect;
export type NewDividendAllocation = typeof dividendAllocations.$inferInsert;
export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type NextOfKin = typeof nextOfKin.$inferSelect;
export type NewNextOfKin = typeof nextOfKin.$inferInsert;
export type ImportBatch = typeof importBatches.$inferSelect;
export type NewImportBatch = typeof importBatches.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type NewLoginAttempt = typeof loginAttempts.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
