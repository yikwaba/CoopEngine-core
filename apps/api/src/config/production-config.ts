/** Validate API configuration before Nest creates providers or starts listening.
 * Errors contain variable names/rules only, never configured values. */
export function validateRuntimeConfiguration(env: NodeJS.ProcessEnv): void {
  const errors: string[] = [];
  const deployment = env.COOPENGINE_ENVIRONMENT?.trim().toLowerCase();
  const production = env.NODE_ENV === 'production' || deployment === 'production';
  const loopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0';
  const missing = (name: string) => !(env[name] ?? '').trim();
  const placeholder = (value: string) => /change[-_ ]?me|replace[-_ ]?me|your[-_ ]|<[^>]+>|^(?:example|dummy|default|test|dev)(?:[-_ ]|$)/i.test(value)
    || ['monnify-dev-secret', 'dev-access-secret-change-me'].includes(value);
  const requireValue = (name: string) => {
    if (missing(name) || placeholder(env[name] ?? '')) errors.push(`${name} must be explicitly configured without a development/placeholder value`);
  };
  const requireSecret = (name: string) => {
    requireValue(name);
    const value = env[name] ?? '';
    if (value.length < 32 || value !== value.trim() || new Set(value).size < 8) {
      errors.push(`${name} must contain at least 32 characters, no surrounding whitespace and sufficient character variety`);
    }
  };
  const origin = (name: string, allowedHost?: (host: string) => boolean) => {
    try {
      const url = new URL(env[name] ?? '');
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
          url.port || loopback(url.hostname) || url.hostname.includes('*') ||
          (allowedHost && !allowedHost(url.hostname))) throw new Error();
      return url;
    } catch { errors.push(`${name} must be an approved HTTPS origin without credentials, path, query or fragment`); }
  };

  if (env.NODE_ENV !== undefined && !['development', 'test', 'production'].includes(env.NODE_ENV)) {
    errors.push('NODE_ENV must be development, test or production');
  }
  for (const [name, live] of [['MEMBER_OTP_PROVIDER', 'termii'], ['MONNIFY_PROVIDER', 'monnify']] as const) {
    const mode = (env[name] ?? 'dev').toLowerCase();
    if (!['dev', live].includes(mode)) errors.push(`${name} must be dev or ${live}`);
    if (production && mode !== live) errors.push(`${name} must be ${live} in production; simulated providers are forbidden`);
  }
  for (const [name, fallback] of [['JWT_ACCESS_TTL_SECONDS', 900], ['REFRESH_TOKEN_TTL_DAYS', 30]] as const) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0 ||
        (name === 'REFRESH_TOKEN_TTL_DAYS' && !Number.isFinite(new Date(Date.now() + value * 86400000).getTime()))) {
      errors.push(`${name} must be a positive safe integer within the supported time range`);
    }
  }

  if (production) {
    if (env.NODE_ENV !== 'production') errors.push('Production deployment requires NODE_ENV=production for secure cookies');
    if (deployment === 'isolated-staging') errors.push('Production cannot enable isolated-staging captures/simulations');
    requireSecret('JWT_ACCESS_SECRET');
    requireSecret('INTERNAL_CRON_TOKEN');
    for (const name of ['TERMII_API_KEY', 'TERMII_SENDER_ID', 'MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE']) requireValue(name);
    // Termii assigns account/regional origins; require the operator to copy
    // their dashboard origin rather than relying on an implicit region.
    requireValue('TERMII_BASE_URL');
    origin('TERMII_BASE_URL', host => host.endsWith('.termii.com'));
    // The payment service defaults to sandbox in development. Production must
    // explicitly select the official live origin, not merely set credentials.
    requireValue('MONNIFY_BASE_URL');
    origin('MONNIFY_BASE_URL', host => host === 'api.monnify.com');
    requireValue('CORS_ORIGINS');
    for (const value of (env.CORS_ORIGINS ?? '').split(',')) {
      try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
            loopback(url.hostname) || url.hostname.includes('*')) throw new Error();
      } catch { errors.push('CORS_ORIGINS must contain explicit HTTPS browser origins'); }
    }
    if (env.PORTAL_PUBLIC_URL !== undefined) origin('PORTAL_PUBLIC_URL');
  }
  if (errors.length) throw new Error(`Invalid API configuration: ${[...new Set(errors)].join('; ')}`);
}
