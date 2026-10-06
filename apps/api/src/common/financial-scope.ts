import { ConflictException } from '@nestjs/common';

/** Browser recovery may survive sign-out. Bind it to the authenticated actor and tenant. */
export function assertFinancialScope(headers: Record<string, unknown>, organizationId: string | null, actorId: string): void {
  const expected = headers['x-coopengine-financial-scope'];
  if (expected !== undefined && expected !== `${organizationId}:${actorId}`) {
    throw new ConflictException('This pending financial request belongs to another account or cooperative. Sign in to its original account to recover it.');
  }
}
