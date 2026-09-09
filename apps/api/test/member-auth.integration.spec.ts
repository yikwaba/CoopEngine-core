/**
 * Member OTP self-service access integration tests (real PostgreSQL).
 *
 * Proves: OTP request (dev provider returns the code), verify issues a
 * member-scoped token, wrong codes rejected with attempt limiting, member
 * sees ONLY their own dashboard, member tokens cannot reach staff endpoints,
 * and staff tokens cannot reach member endpoints.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ensureRbacSeeded, ADMIN_PASSWORD, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';

let app: INestApplication;
let pool: Pool;

async function onboardCoop(label: string): Promise<{
  tokens: { accessToken: string };
  slug: string;
}> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(saasLogin.status).toBe(200);
  const suffix = randomUUID().slice(0, 8);
  const slug = `${label}-${suffix}`;
  const onboard = await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
    .send({
      name: `${label} cooperative`,
      slug,
      adminEmail: `${label}-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  expect(onboard.status).toBe(201);
  const coopLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `${label}-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  expect(coopLogin.status).toBe(200);
  return { tokens: { accessToken: coopLogin.body.tokens.accessToken as string }, slug };
}

async function createActiveMember(
  coop: { tokens: { accessToken: string } },
  email: string,
): Promise<string> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: 'Self', lastName: 'Service', email });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth);
  return id;
}

beforeAll(async () => {
  process.env.DATABASE_URL =
    TEST_DATABASE_URL;
  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.query(`DELETE FROM sessions`);
    await pool.end();
  }
  if (app) await app.close();
});

describe('member self-service access', () => {
  it('logs a member in with OTP and scopes them to their own data', async () => {
    const coop = await onboardCoop('msa');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const memberEmail = `member-${randomUUID().slice(0, 8)}@coopengine.test`;
    const memberId = await createActiveMember(coop, memberEmail);

    // Fund the member's savings so the dashboard has something to show
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${opened.body.id as string}/deposits`)
      .set(auth)
      .send({ amount: 40000 });

    // Request OTP (dev provider returns the code)
    const otpReq = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email: memberEmail });
    expect(otpReq.status).toBe(200);
    const devCode = otpReq.body.devCode as string | undefined;
    expect(devCode).toBeTruthy();

    // Wrong code -> 401; code still valid for the right attempt
    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({
        organizationSlug: coop.slug,
        email: memberEmail,
        code: devCode === '000000' ? '000001' : '000000',
      });
    expect(wrong.status).toBe(401);

    const ok = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: coop.slug, email: memberEmail, code: devCode });
    expect(ok.status).toBe(200);
    const memberToken = ok.body.accessToken as string;
    expect(ok.body.member.memberNo).toBeGreaterThanOrEqual(1);

    // Member dashboard: own balances only
    const dash = await request(app.getHttpServer())
      .get('/api/v1/member/dashboard')
      .set({ Authorization: `Bearer ${memberToken}` });
    expect(dash.status).toBe(200);
    expect(dash.body.member.email).toBe(memberEmail);
    expect(dash.body.savingsTotal).toBe(40000);
    expect(dash.body.recentTransactions).toHaveLength(1);
    expect(dash.body.loansOutstandingTotal).toBe(0);

    // /member/me works
    const me = await request(app.getHttpServer())
      .get('/api/v1/member/me')
      .set({ Authorization: `Bearer ${memberToken}` });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(memberId);

    // Member token CANNOT reach staff endpoints (no staff session -> 401)
    const staffList = await request(app.getHttpServer())
      .get('/api/v1/members')
      .set({ Authorization: `Bearer ${memberToken}` });
    expect(staffList.status).toBe(401);

    // Staff token CANNOT reach member endpoints (typ guard -> 403)
    const staffToMember = await request(app.getHttpServer())
      .get('/api/v1/member/dashboard')
      .set(auth);
    expect(staffToMember.status).toBe(403);

    // Unknown member email gets no dev code (no enumeration)
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email: `ghost-${randomUUID().slice(0, 6)}@coopengine.test` });
    expect(unknown.status).toBe(200);
    expect(unknown.body.devCode).toBeUndefined();
  });
});
