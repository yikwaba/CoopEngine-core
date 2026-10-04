export const PRIVILEGED_ROLES = ['SAAS_ADMIN', 'COOP_ADMIN', 'TREASURER', 'ACCOUNTANT', 'LOAN_OFFICER', 'CREDIT_COMMITTEE', 'AUDITOR', 'CHAIRMAN', 'SECRETARY'];
export function isPrivilegedStaff(roles: string[], permissions: string[]): boolean {
  return roles.some(r => PRIVILEGED_ROLES.includes(r)) || permissions.some(p =>
    // Only explicitly read-only grants are exempt. This denies by default for
    // custom/future write grants (withdraw, reconcile, capture, upload, etc.),
    // instead of relying on a short list of familiar financial verbs.
    p.startsWith('saas.') || !/\.(view|lookup)$/.test(p));
}
export function requiresPrivilegedMfa(roles: string[], permissions: string[], tenantRequired: boolean, environment = process.env.NODE_ENV): boolean {
  return isPrivilegedStaff(roles, permissions) && (environment === 'production' || tenantRequired);
}
