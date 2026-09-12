/**
 * MFA (TOTP) + login rate-limiting integration tests (real PostgreSQL).
 *
 * Flow covered: SaaS admin logs in -> enables MFA -> next login demands a
 * challenge -> TOTP verified -> tokens issued -> MFA disabled via code.
 * Rate limiting: 5 failed attempts then 429.
 *
 * Prerequisites: local Postgres, migrations applied, `db:seed` run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { generateSync } from 'otplib/functional';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ensureRbacSeeded, ADMIN_PASSWORD, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';

let app: INestApplication;
let pool: Pool;

function codeFor(secret: string): string {
  return generateSync({ secret });
}

async function login(email: string, password: string, slug?: string) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send(slug ? { email, password, organizationSlug: slug } : { email, password });
  expect(res.status).toBe(200);
  return res.body as {
    user: { id: string; email: string };
    organizations: { id: string; slug: string }[];
    requiresOrgSelection: boolean;
    requiresMfa: boolean;
    mfaToken?: string;
    tokens?: {
      accessToken: string;
      refreshToken: string;
      organization: { id: string; slug: string } | null;
      permissions: string[];
    };
  };
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL;

  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
});

afterAll(async () => {
  if (pool) {
    // Reset the seeded admin back to no-MFA for repeatable runs.
    await pool.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE email = $1`,
      [ADMIN_EMAIL],
    );
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.query(`DELETE FROM login_attempts WHERE email LIKE 'ratelimit%'`);
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (
         SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.end();
  }
  if (app) await app.close();
});

describe('MFA (TOTP)', () => {
  it('enables MFA, demands a challenge on next login, then issues tokens after TOTP', async () => {
    const saas = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(saas.requiresMfa).toBe(false);

    // Setup
    const setupRes = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${saas.tokens?.accessToken}`);
    expect(setupRes.status).toBe(201);
    const { secret, otpauthUrl } = setupRes.body as {
      secret: string;
      otpauthUrl: string;
    };
    expect(secret).toBeTruthy();
    expect(otpauthUrl).toContain('otpauth://totp/');

    // Wrong code rejected at setup
    const badVerify = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify-setup')
      .set('Authorization', `Bearer ${saas.tokens?.accessToken}`)
      .send({ code: '000000' });
    expect(badVerify.status).toBe(401);

    // Correct code enables MFA
    const verifySetup = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/verify-setup')
      .set('Authorization', `Bearer ${saas.tokens?.accessToken}`)
      .send({ code: codeFor(secret) });
    expect(verifySetup.status).toBe(204);

    // Next login demands the MFA challenge instead of tokens
    const challenged = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(challenged.requiresMfa).toBe(true);
    expect(challenged.mfaToken).toBeTruthy();
    expect(challenged.tokens).toBeUndefined();

    // Wrong TOTP on challenge is rejected
    const badChallenge = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/login-verify')
      .send({ mfaToken: challenged.mfaToken, code: '000000' });
    expect(badChallenge.status).toBe(401);

    // Correct TOTP issues tokens (saas context: org null)
    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/login-verify')
      .send({ mfaToken: challenged.mfaToken, code: codeFor(secret) });
    expect(verified.status).toBe(200);
    expect(verified.body.tokens?.accessToken).toBeDefined();
    expect(verified.body.tokens?.organization).toBeNull();
    expect(verified.body.tokens?.permissions).toContain('saas.tenants.manage');

    // Disable MFA (requires current code)
    const disable = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${verified.body.tokens?.accessToken}`)
      .send({ code: codeFor(secret) });
    expect(disable.status).toBe(204);

    // Plain login works again
    const plain = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(plain.requiresMfa).toBe(false);
    expect(plain.tokens?.accessToken).toBeDefined();
  });
});

describe('login rate limiting', () => {
  it('returns 429 after 5 failed attempts in the window', async () => {
    const email = `ratelimit-${Date.now()}@coopengine.test`;
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPass123!' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(401); // attempts counted, still 401 before threshold
    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass123!' });
    expect(blocked.status).toBe(429);
  });
});
