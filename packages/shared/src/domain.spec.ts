import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOAN_MULTIPLIER,
  DEFAULT_CASH_LOAN_RATE_PA,
  DEFAULT_ASSET_FINANCE_RATE_PA,
  DEFAULT_ALLOCATION_ORDER,
} from '../src/domain';

describe('approved domain defaults (Decision Log v1.1)', () => {
  it('uses 3x default loan multiplier', () => {
    expect(DEFAULT_LOAN_MULTIPLIER).toBe(3);
  });

  it('uses 15% p.a. default cash-loan rate', () => {
    expect(DEFAULT_CASH_LOAN_RATE_PA).toBe(15);
  });

  it('uses 12.5% p.a. default asset-finance rate', () => {
    expect(DEFAULT_ASSET_FINANCE_RATE_PA).toBe(12.5);
  });

  it('default allocation order starts with penalties and ends with principal', () => {
    expect(DEFAULT_ALLOCATION_ORDER[0]).toBe('penalties');
    expect(DEFAULT_ALLOCATION_ORDER[DEFAULT_ALLOCATION_ORDER.length - 1]).toBe(
      'principal',
    );
  });
});
