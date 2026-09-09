const isProduction = process.env.NODE_ENV === 'production';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required when NODE_ENV=production (refusing to boot with a dev fallback)`,
    );
  }
  return value;
}

export const ENV = {
  jwtAccessSecret: isProduction
    ? required('JWT_ACCESS_SECRET')
    : process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
  jwtAccessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3100,http://localhost:3200')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;
