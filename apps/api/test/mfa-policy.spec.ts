import { describe, expect, it } from 'vitest';
import { PRIVILEGED_ROLES, requiresPrivilegedMfa } from '../src/auth/mfa-policy';
describe('mandatory privileged MFA', () => {
  for (const role of PRIVILEGED_ROLES) it(`${role} cannot opt out in production`, () => {
    expect(requiresPrivilegedMfa([role], [], false, 'production')).toBe(true);
    expect(requiresPrivilegedMfa([role], [], false, 'test')).toBe(false);
    expect(requiresPrivilegedMfa([role], [], true, 'development')).toBe(true);
  });
  for (const permission of ['saas.support.access','users.manage','loans.disburse','journals.post','payroll.reverse','savings.approve',
    'savings.withdraw','loans.restructure','payments.reconcile','collections.capture','payroll.upload','members.edit','members.export','future.execute']) {
    it(`custom role with ${permission} is privileged`, () => expect(requiresPrivilegedMfa(['CUSTOM'], [permission], false, 'production')).toBe(true));
  }
  it('does not turn a minimal lookup role or no grant into privilege', () => {
    expect(requiresPrivilegedMfa(['CUSTOM'], ['members.lookup'], false, 'production')).toBe(false);
    expect(requiresPrivilegedMfa([], [], true, 'production')).toBe(false);
  });
});
