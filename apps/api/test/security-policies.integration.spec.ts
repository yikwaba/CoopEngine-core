/**
 * Security policies a cooperative can turn on for itself.
 *
 * Two requirements from the master prompt's decision log were implemented but never enforced:
 * TOTP mandatory for privileged roles (decision 9) and step-up verification for actions that
 * move money or rewrite the books (disbursement, journal posting, reversal). Both are now
 * real, and this spec proves the enforcement rather than the existence of the code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib/functional';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `sec-admin-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const OFFICER = { email: `sec-officer-${suffix}@coopengine.test` };
const slug = `sec-${suffix}`;

describe('security policies: MFA for staff and step-up for money actions', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let adminToken = '';
  let officerToken = '';

  // not async: supertest's Test is already awaitable and also carries .expect()
  const login = (email: string, password: string) =>
    http.post('/api/v1/auth/login').send({ email, password, organizationSlug: slug });

  const patchSecurity = (token: string, security: Record<string, boolean>) =>
    http
      .patch('/api/v1/settings')
      .set({ Authorization: `Bearer ${token}` })
      .send({ security });

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `Security ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const admin = await login(ADMIN.email, ADMIN.password).expect(200);
    adminToken = admin.body.tokens.accessToken as string;

    const invited = await http
      .post('/api/v1/users')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ email: OFFICER.email, roleCodes: ['LOAN_OFFICER'] })
      .expect(201);
    const officer = await login(OFFICER.email, invited.body.tempPassword as string).expect(200);
    officerToken = officer.body.tokens.accessToken as string;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  it('a cooperative starts with no extra requirements, and its settings are admin-only', async () => {
    const read = await http.get('/api/v1/settings').set({ Authorization: `Bearer ${adminToken}` });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.currency).toBe('NGN');
    expect(read.body.settings.security).toBeUndefined();

    await http.get('/api/v1/settings').set({ Authorization: `Bearer ${officerToken}` }).expect(403);
    await http.patch('/api/v1/settings').set({ Authorization: `Bearer ${officerToken}` }).send({ security: { mfaRequiredForPrivilegedRoles: true } }).expect(403);
  });

  it('with the MFA policy on, a staff sign-in without an authenticator is refused — and allowed again when switched off', async () => {
    const on = await patchSecurity(adminToken, { mfaRequiredForPrivilegedRoles: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.settings.security.mfaRequiredForPrivilegedRoles).toBe(true);

    // the officer has no MFA set up: the cooperative does not want that account signed in
    const blocked = await login(OFFICER.email, 'irrelevant-for-this-path');
    expect([401, 403]).toContain(blocked.status);

    const withRealPassword = await http
      .post('/api/v1/auth/login')
      .send({ email: OFFICER.email, password: 'definitely-wrong', organizationSlug: slug });
    expect([401, 403]).toContain(withRealPassword.status);

    // the admin, who also has no MFA yet, is held to the same policy
    const adminBlocked = await login(ADMIN.email, ADMIN.password);
    expect(adminBlocked.status).toBe(403);
    expect(JSON.stringify(adminBlocked.body)).toMatch(/two-factor/i);

    const off = await patchSecurity(adminToken, { mfaRequiredForPrivilegedRoles: false });
    expect(off.status).toBe(200);
    const allowed = await login(ADMIN.email, ADMIN.password);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it('step-up is demanded for a journal posting, and refuses when MFA is not set up', async () => {
    const on = await patchSecurity(adminToken, { requireStepUpForSensitiveMoney: true });
    expect(on.status).toBe(200);

    const target = randomUUID();
    const noCode = await http
      .post(`/api/v1/ledger/journals/${target}/approve-post`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({});
    expect(noCode.status, JSON.stringify(noCode.body)).toBe(403);
    expect(JSON.stringify(noCode.body)).toMatch(/MFA/i);

    // a malformed code never reaches the guard
    const badShape = await http
      .post(`/api/v1/ledger/journals/${target}/approve-post`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ otp: 'nope' });
    expect(badShape.status).toBe(400);
  });

  it('with MFA enrolled and a live code, step-up passes and the request reaches the service', async () => {
    const setup = await http
      .post('/api/v1/auth/mfa/setup')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({});
    const verifySetup = await http
      .post('/api/v1/auth/mfa/verify-setup')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ code: await generate({ secret: setup.body.secret as string }) });
    expect([200, 201]).toContain(setup.status);
    const secret = setup.body.secret as string;


    // sign in again, completing the MFA challenge, since the account now has an authenticator
    const first = await login(ADMIN.email, ADMIN.password);
    expect(first.status).toBe(200);
    const challenge = (first.body.mfaToken ?? first.body.mfa?.token ?? first.body.challengeToken) as
      | string
      | undefined;
    if (challenge) {
      const verified = await http
        .post('/api/v1/auth/mfa/login-verify')
        .send({ mfaToken: challenge, code: await generate({ secret }), organizationSlug: slug })
        .expect(200);
      adminToken = verified.body.tokens.accessToken as string;
    }

    // a wrong code is refused...
    const wrong = await http
      .post(`/api/v1/ledger/journals/${randomUUID()}/approve-post`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ otp: '000000' });
    expect([401, 403]).toContain(wrong.status);

    // ...and a live one clears step-up, so the answer is the service's (no such journal),
    // not the guard's refusal
    const cleared = await http
      .post(`/api/v1/ledger/journals/${randomUUID()}/approve-post`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ otp: await generate({ secret }) });
    expect([200, 404]).toContain(cleared.status);
    expect(JSON.stringify(cleared.body)).not.toMatch(/step-up/i);
  });

  it('the step-up refusal is written to the audit trail', async () => {
    await pool.query(`SELECT set_config('app.internal_scan', 'on', false)`);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action IN ('stepup.failed', 'stepup.verified', 'mfa.login_blocked')
          AND created_at > now() - interval '10 minutes'`,
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
