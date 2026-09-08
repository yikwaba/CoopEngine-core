/**
 * Co-opEngine shared domain primitives.
 * Single source of truth for cross-cutting constants and enums used by
 * the API, portal and member PWA. Approved in Decision Log v1.1.
 */

/** Money is always NUMERIC(19,2) at rest; keep kobo-safe math in code. */
export const MONEY_SCALE = 2;
export const MONEY_PRECISION = 19;

/** Default loan ceiling multiplier: 3x qualifying net savings (FR-015). */
export const DEFAULT_LOAN_MULTIPLIER = 3;

/** Default cash-loan flat interest rate, % per annum (FR-016). */
export const DEFAULT_CASH_LOAN_RATE_PA = 15;

/** Default asset/item-finance flat interest rate, % per annum (FR-017). */
export const DEFAULT_ASSET_FINANCE_RATE_PA = 12.5;

/** Default repayment allocation order (penalties -> fees -> interest -> principal). */
export const DEFAULT_ALLOCATION_ORDER = [
  'penalties',
  'fees',
  'interest',
  'principal',
] as const;

/** Delinquency milestones in days past due (DPD) — PRD §10.6. */
export const DELINQUENCY_MILESTONES = {
  overdueFrom: 1,
  escalatedFrom: 15,
  defaultFrom: 30,
} as const;

/** Default delinquency job time, WAT. */
export const DELINQUENCY_JOB_CRON = '59 23 * * *';

/** Tenant lifecycle states. */
export const ORGANIZATION_STATUS = [
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUS)[number];

/** Accounting period states — PRD §11. */
export const ACCOUNTING_PERIOD_STATE = [
  'OPEN',
  'SOFT_CLOSED',
  'LOCKED',
] as const;
export type AccountingPeriodState = (typeof ACCOUNTING_PERIOD_STATE)[number];

export type AccountType =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'INCOME'
  | 'EXPENSE';

export interface DefaultAccount {
  code: string;
  name: string;
  type: AccountType;
  category: string;
}

/**
 * Baseline chart of accounts seeded for every cooperative at onboarding
 * (Decision Log v1.1 — owner-approved; external accountant review deferred).
 */
export const DEFAULT_CHART_OF_ACCOUNTS: DefaultAccount[] = [
  { code: '1000', name: 'Cash at Bank', type: 'ASSET', category: 'Cash & Bank' },
  { code: '1010', name: 'Cash on Hand', type: 'ASSET', category: 'Cash & Bank' },
  { code: '1020', name: 'Loan Receivables', type: 'ASSET', category: 'Loans' },
  { code: '1030', name: 'Accrued Interest Receivable', type: 'ASSET', category: 'Loans' },
  { code: '1100', name: 'Property and Equipment', type: 'ASSET', category: 'Fixed Assets' },
  { code: '2000', name: 'Member Savings Deposits', type: 'LIABILITY', category: 'Member Funds' },
  { code: '2010', name: 'Due to Members', type: 'LIABILITY', category: 'Member Funds' },
  { code: '2100', name: 'Accrued Expenses', type: 'LIABILITY', category: 'Liabilities' },
  { code: '3000', name: 'Member Share Capital', type: 'EQUITY', category: 'Capital' },
  { code: '3010', name: 'Retained Earnings', type: 'EQUITY', category: 'Capital' },
  { code: '3020', name: 'Current Year Earnings', type: 'EQUITY', category: 'Capital' },
  { code: '4000', name: 'Loan Interest Income', type: 'INCOME', category: 'Income' },
  { code: '4010', name: 'Investment Income', type: 'INCOME', category: 'Income' },
  { code: '4020', name: 'Fees and Charges Income', type: 'INCOME', category: 'Income' },
  { code: '4030', name: 'Penalties Income', type: 'INCOME', category: 'Income' },
  { code: '5000', name: 'Interest on Savings', type: 'EXPENSE', category: 'Expenses' },
  { code: '5010', name: 'Administrative Expenses', type: 'EXPENSE', category: 'Expenses' },
  { code: '5020', name: 'Loan Loss Provision', type: 'EXPENSE', category: 'Expenses' },
  { code: '5030', name: 'Depreciation', type: 'EXPENSE', category: 'Expenses' },
];

/** YYYY-MM code + inclusive date range for a month period. */
export function monthPeriod(
  year: number,
  month: number, // 1-12
): { code: string; startDate: string; endDate: string } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // last day of month
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  return {
    code: `${year}-${String(month).padStart(2, '0')}`,
    startDate: iso(start),
    endDate: iso(end),
  };
}

/** Tenant-scoped core table prefix guarantee (RLS strategy). */
export const TENANT_ID_COLUMN = 'organization_id' as const;
