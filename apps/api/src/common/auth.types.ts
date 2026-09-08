/** Authenticated principal attached to the request by JwtAuthGuard. */
export interface AuthPrincipal {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  permissions: string[];
}

/** Shape of the signed access-token claims. */
export interface JwtClaims {
  sub: string;
  sid: string;
  org: string | null;
  perms: string[];
}
