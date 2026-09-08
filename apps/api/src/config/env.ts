/** Runtime environment with development defaults (never prod secrets). */
export const ENV = {
  jwtAccessSecret:
    process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
  jwtAccessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
} as const;
