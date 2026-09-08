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

/** Tenant-scoped core table prefix guarantee (RLS strategy). */
export const TENANT_ID_COLUMN = 'organization_id' as const;
