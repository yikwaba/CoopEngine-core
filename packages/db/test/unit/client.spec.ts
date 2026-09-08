import { describe, it, expect } from 'vitest';
import { TENANT_GUC } from '../../src/schema';
import { DEFAULT_DATABASE_URL, currentTenantId } from '../../src/client';

describe('tenant GUC and client contracts', () => {
  it('exposes the tenant GUC name used by RLS policies', () => {
    expect(TENANT_GUC).toBe('app.tenant_id');
  });

  it('defaults local DATABASE_URL to the dev Postgres', () => {
    expect(DEFAULT_DATABASE_URL).toContain('127.0.0.1:5432/coopengine');
  });

  it('currentTenantId is exported as a helper', () => {
    expect(typeof currentTenantId).toBe('function');
  });
});
