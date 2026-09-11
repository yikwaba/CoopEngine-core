/**
 * Late-integration readiness (real PostgreSQL).
 *
 * Proves the platform is fully usable with NO SMS, email or payment gateway
 * configured, and that turning each one on later is a configuration change —
 * not a code change. This is the guarantee that lets the SaaS ship now while
 * Termii / Brevo / Monnify stay pending.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `ready-admin-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const MEMBER = {
  email: `ready-member-${suffix}@coopengine.test`,
  // numeric: base36 slugs contain letters, which the phone validator rejects
  phone: `+23480${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
};

const PROVIDER_KEYS = [
  'MEMBER_OTP_PROVIDER', 'TERMII_API_KEY', 'TERMII_SENDER_ID', 'TERMII_BASE_URL',
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'MONNIFY_PROVIDER', 'MONNIFY_API_KEY', 'MONNIFY_SECRET_KEY', 'MONNIFY_CONTRACT_CODE',
];

describe('late-integration readiness', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let adminToken = '';
  let memberId = '';
  let accountId = '';
  let saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    saved = Object.fromEntries(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
    PROVIDER_KEYS.forEach((k) => delete process.env[k]); // nothing configured

    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const slug = `ready-${suffix}`;
    // Onboarding is a SaaS-admin action, as in the rest of the suite.
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    const saasToken = saas.body.tokens.accessToken as string;

    const onboard = await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saasToken}` })
      .send({ name: `Ready ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password });
    if (onboard.status !== 201) throw new Error(`ONBOARD: ${JSON.stringify(onboard.body)}`);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug });
    if (login.status !== 200) throw new Error(`LOGIN: ${JSON.stringify(login.body)}`);
    adminToken = login.body.tokens.accessToken as string;

    const created = await http
      .post('/api/v1/members')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({
        firstName: 'NoProvider',
        lastName: 'Member',
        email: MEMBER.email,
        phone: MEMBER.phone,
        joinedOn: '2026-01-15',
      });
    memberId = (created.body.id ?? created.body.member?.id) as string;
    if (!memberId) throw new Error(`MEMBER: ${JSON.stringify(created.body)}`);

    await http
      .post(`/api/v1/members/${memberId}/approve`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({});

    const account = await http
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({});
    accountId = (account.body.id ?? account.body.account?.id) as string;
    if (!accountId) throw new Error(`ACCOUNT: ${JSON.stringify(account.body)}`);
  });

  afterAll(async () => {
    PROVIDER_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    });
    await app?.close();
    await pool.end();
  });

  it('reports every integration as simulated, and names what to run later', async () => {
    const res = await http
      .get('/api/v1/health/providers')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);

    expect(res.body.providers.sms.mode).toBe('dev');
    expect(res.body.providers.email.mode).toBe('dev');
    expect(res.body.providers.payments.mode).toBe('dev');
    // It tells the operator exactly which variables are missing and how to finish.
    expect(res.body.providers.sms.missingEnv).toContain('TERMII_API_KEY');
    expect(res.body.providers.sms.enableWith).toContain('provider-switch.sh');
    expect(res.body.providers.email.enableWith).toContain('smtp-configure.sh');
    // Real members need real OTP delivery — this is the one hard blocker.
    expect(res.body.readyForRealMembers).toBe(false);
    expect(JSON.stringify(res.body.warnings)).toContain('SMS OTP is simulated');
    // Never leak a credential VALUE. Names such as MONNIFY_SECRET_KEY are expected,
    // so assert that no secret material itself appears anywhere in the response.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/dummy-|xkeysib-|sk_live|MK_PROD/);
    expect(res.body.providers.payments.requiredEnv).toContain('MONNIFY_SECRET_KEY');
    expect(body).not.toContain(process.env.SMTP_PASS ?? '@@none@@');
  });

  it('keeps the integration readiness report behind permissions', async () => {
    await http.get('/api/v1/health/providers').expect(401);
    const noPerms = await http
      .get('/api/v1/health/providers')
      .set({ Authorization: 'Bearer not-a-real-token' })
      .expect(401);
    expect(noPerms.body).toBeTruthy();
    // public /health stays open and unchanged
    const open = await http.get('/api/v1/health').expect(200);
    expect(open.body.status).toBe('ok');
  });

  it('runs the whole money loop with no providers configured', async () => {
    const dep = await http
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ amount: 25000, description: 'Manual counter deposit (no gateway)' });
    expect([200, 201]).toContain(dep.status);
    expect(Number(dep.body.currentBalance)).toBe(25000);

    const loanProduct = await http
      .get('/api/v1/products/loans')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    expect(Array.isArray(loanProduct.body)).toBe(true);

    // Books balance even though no payment gateway exists.
    const tb = await http
      .get('/api/v1/ledger/trial-balance')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    expect(Number(tb.body.net)).toBe(0);
  });

  it('flips each channel to live purely by setting environment variables', async () => {
    process.env.MEMBER_OTP_PROVIDER = 'termii';
    process.env.TERMII_API_KEY = 'dummy-key-for-readiness-probe';
    process.env.TERMII_SENDER_ID = 'COOPENG';
    process.env.SMTP_HOST = 'smtp-relay.brevo.com';
    process.env.SMTP_USER = 'dummy@coopengine.test';
    process.env.SMTP_PASS = 'dummy-smtp-key';
    process.env.MONNIFY_PROVIDER = 'monnify';
    process.env.MONNIFY_API_KEY = 'dummy-api-key';
    process.env.MONNIFY_SECRET_KEY = 'dummy-secret-key';
    process.env.MONNIFY_CONTRACT_CODE = '0000000000';

    const res = await http
      .get('/api/v1/health/providers')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);

    expect(res.body.providers.sms.mode).toBe('live');
    expect(res.body.providers.email.mode).toBe('live');
    expect(res.body.providers.payments.mode).toBe('live');
    expect(res.body.providers.sms.missingEnv).toEqual([]);
    expect(res.body.readyForRealMembers).toBe(true);
    expect(res.body.warnings).toEqual([]);
  });

  it('attempts real SMS delivery once configured, and never leaks the code on failure', async () => {
    // Dummy credentials: the provider call must fail gracefully, the response must
    // stay generic, and the failure must be audit-visible.
    const otp = await http
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: `ready-${suffix}`, email: MEMBER.email });
    expect([200, 201]).toContain(otp.status);
    expect(otp.body.provider).toBe('termii');
    expect(otp.body.devCode).toBeUndefined(); // never returned when a real provider is used

    const audit = await pool.query(
      `select action from audit_logs where action = 'member.otp.delivery_failed' order by created_at desc limit 1`,
    );
    expect(audit.rows.length).toBe(1);
  });
});
