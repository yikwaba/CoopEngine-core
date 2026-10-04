import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRuntimeConfiguration } from '../src/config/production-config';

// Synthetic fixtures: configuration acceptance is not credential/provider proof.
const valid: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', COOPENGINE_ENVIRONMENT: 'production',
  JWT_ACCESS_SECRET: 'SigningFixture_9G7vAq1K4h8Bj2Rm6Xs3Df5T0cZ',
  INTERNAL_CRON_TOKEN: 'MachineFixture_4G7hK2vR9aQ5mT8zD1bF6cX0sJ3N',
  MEMBER_OTP_PROVIDER: 'termii', MONNIFY_PROVIDER: 'monnify',
  TERMII_API_KEY: 'TermiiFixtureApiKey_234', TERMII_SENDER_ID: 'CoopEngine',
  TERMII_BASE_URL: 'https://api.ng.termii.com',
  MONNIFY_API_KEY: 'MonnifyFixtureApiKey_234', MONNIFY_SECRET_KEY: 'MonnifyFixtureSecretKey_234',
  MONNIFY_CONTRACT_CODE: 'FixtureContract234', MONNIFY_BASE_URL: 'https://api.monnify.com',
  CORS_ORIGINS: 'https://app.example.com,https://members.example.com',
};
const invalidCases: [string, NodeJS.ProcessEnv, string][] = [
  ['missing OTP selection', { MEMBER_OTP_PROVIDER: undefined }, 'MEMBER_OTP_PROVIDER'],
  ['development OTP', { MEMBER_OTP_PROVIDER: 'dev' }, 'MEMBER_OTP_PROVIDER'],
  ['unsupported OTP', { MEMBER_OTP_PROVIDER: 'typo' }, 'MEMBER_OTP_PROVIDER'],
  ['missing payment selection', { MONNIFY_PROVIDER: undefined }, 'MONNIFY_PROVIDER'],
  ['development payments', { MONNIFY_PROVIDER: 'dev' }, 'MONNIFY_PROVIDER'],
  ['unsupported payments', { MONNIFY_PROVIDER: 'typo' }, 'MONNIFY_PROVIDER'],
  ['missing JWT', { JWT_ACCESS_SECRET: undefined }, 'JWT_ACCESS_SECRET'],
  ['short JWT', { JWT_ACCESS_SECRET: 'short' }, 'JWT_ACCESS_SECRET'],
  ['default JWT', { JWT_ACCESS_SECRET: 'dev-access-secret-change-me' }, 'JWT_ACCESS_SECRET'],
  ['low-variety JWT', { JWT_ACCESS_SECRET: 'a'.repeat(64) }, 'JWT_ACCESS_SECRET'],
  ['placeholder JWT', { JWT_ACCESS_SECRET: 'replace-me-with-your-long-secret-123456' }, 'JWT_ACCESS_SECRET'],
  ['whitespace JWT', { JWT_ACCESS_SECRET: ' ' + valid.JWT_ACCESS_SECRET }, 'JWT_ACCESS_SECRET'],
  ['missing cron token', { INTERNAL_CRON_TOKEN: undefined }, 'INTERNAL_CRON_TOKEN'],
  ['short cron token', { INTERNAL_CRON_TOKEN: 'short' }, 'INTERNAL_CRON_TOKEN'],
  ['default webhook key', { MONNIFY_SECRET_KEY: 'monnify-dev-secret' }, 'MONNIFY_SECRET_KEY'],
  ['missing payment origin', { MONNIFY_BASE_URL: undefined }, 'MONNIFY_BASE_URL'],
  ['sandbox payments', { MONNIFY_BASE_URL: 'https://sandbox.monnify.com' }, 'MONNIFY_BASE_URL'],
  ['HTTP payments', { MONNIFY_BASE_URL: 'http://api.monnify.com' }, 'MONNIFY_BASE_URL'],
  ['payment host suffix attack', { MONNIFY_BASE_URL: 'https://api.monnify.com.evil.example' }, 'MONNIFY_BASE_URL'],
  ['payment URL credentials', { MONNIFY_BASE_URL: 'https://user:pass@api.monnify.com' }, 'MONNIFY_BASE_URL'],
  ['payment URL path', { MONNIFY_BASE_URL: 'https://api.monnify.com/other' }, 'MONNIFY_BASE_URL'],
  ['missing Termii origin', { TERMII_BASE_URL: undefined }, 'TERMII_BASE_URL'],
  ['HTTP Termii', { TERMII_BASE_URL: 'http://api.ng.termii.com' }, 'TERMII_BASE_URL'],
  ['wrong Termii host', { TERMII_BASE_URL: 'https://termii.com.evil.example' }, 'TERMII_BASE_URL'],
  ['Termii URL fragment', { TERMII_BASE_URL: 'https://api.ng.termii.com/#secret' }, 'TERMII_BASE_URL'],
  ['missing CORS', { CORS_ORIGINS: undefined }, 'CORS_ORIGINS'],
  ['HTTP CORS', { CORS_ORIGINS: 'http://app.example.com' }, 'CORS_ORIGINS'],
  ['wildcard CORS', { CORS_ORIGINS: 'https://*.example.com' }, 'CORS_ORIGINS'],
  ['loopback CORS', { CORS_ORIGINS: 'https://127.0.0.1' }, 'CORS_ORIGINS'],
  ['CORS path', { CORS_ORIGINS: 'https://app.example.com/other' }, 'CORS_ORIGINS'],
  ['isolated capture in production', { COOPENGINE_ENVIRONMENT: 'isolated-staging' }, 'isolated-staging'],
  ['production marker with development Node', { NODE_ENV: 'development' }, 'NODE_ENV'],
  ['production marker without Node flag', { NODE_ENV: undefined }, 'NODE_ENV'],
  ['unsafe public portal origin', { PORTAL_PUBLIC_URL: 'http://app.example.com' }, 'PORTAL_PUBLIC_URL'],
];
for (const name of ['TERMII_API_KEY', 'TERMII_SENDER_ID', 'MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE']) {
  invalidCases.push([`missing ${name}`, { [name]: '' }, name]);
}
describe('API configuration rejects unsafe production modes', () => {
  it('accepts explicit production configuration without making provider calls', () => {
    expect(() => validateRuntimeConfiguration(valid)).not.toThrow();
  });
  for (const [label, overrides, expected] of invalidCases) {
    it(label, () => expect(() => validateRuntimeConfiguration({ ...valid, ...overrides })).toThrow(expected));
  }
  it('retains isolated staging simulation and default development/test configuration', () => {
    for (const env of [{}, { NODE_ENV: 'test' }, { NODE_ENV: 'development', COOPENGINE_ENVIRONMENT: 'isolated-staging', MEMBER_OTP_PROVIDER: 'dev', MONNIFY_PROVIDER: 'dev' }]) {
      expect(() => validateRuntimeConfiguration(env)).not.toThrow();
    }
  });
  it('rejects misspelled environment/provider modes even outside production', () => {
    for (const env of [{ NODE_ENV: 'Production' }, { MEMBER_OTP_PROVIDER: 'termii ' }, { MONNIFY_PROVIDER: 'monify' }]) {
      expect(() => validateRuntimeConfiguration(env)).toThrow();
    }
  });
  it('recognizes case/whitespace variants of the production deployment marker', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'development', COOPENGINE_ENVIRONMENT: ' Production ' })).toThrow('NODE_ENV');
  });
  for (const name of ['JWT_ACCESS_TTL_SECONDS', 'REFRESH_TOKEN_TTL_DAYS']) {
    for (const value of ['0', '-1', 'NaN', '', '1.5', 'Infinity', '99999999999999999']) {
      it(`${name} rejects ${value || 'empty'}`, () => expect(() => validateRuntimeConfiguration({ [name]: value })).toThrow(name));
    }
  }
  it('error diagnostics never print supplied secret values', () => {
    const sentinel = 'DO_NOT_PRINT_THIS_CONFIGURED_SECRET_123';
    try { validateRuntimeConfiguration({ ...valid, JWT_ACCESS_SECRET: sentinel + ' ' }); throw new Error('Expected rejection'); }
    catch (e) { expect((e as Error).message).toContain('JWT_ACCESS_SECRET'); expect((e as Error).message).not.toContain(sentinel); }
  });
});

describe('compiled ENV startup boundary', () => {
  const file = fileURLToPath(new URL('../dist/config/env.js', import.meta.url));
  it('unsafe production configuration exits before application startup', () => {
    const result = spawnSync(process.execPath, [file], { env: { ...process.env, ...valid, MEMBER_OTP_PROVIDER: 'dev' }, encoding: 'utf8', timeout: 5000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MEMBER_OTP_PROVIDER');
    expect(result.stderr).not.toContain(valid.JWT_ACCESS_SECRET);
  });
  it('valid production configuration loads and canonicalizes allowed origins', () => {
    const result = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(file)}).ENV.corsOrigins))`],
      { env: { ...process.env, ...valid, CORS_ORIGINS: 'https://app.example.com/,https://members.example.com:443' }, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(['https://app.example.com', 'https://members.example.com']);
  });
  it('isolated staging still loads with its synthetic providers', () => {
    const result = spawnSync(process.execPath, [file], { env: { ...process.env, NODE_ENV: 'development', COOPENGINE_ENVIRONMENT: 'isolated-staging', MEMBER_OTP_PROVIDER: 'dev', MONNIFY_PROVIDER: 'dev' }, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
  });
});
