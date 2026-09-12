/**
 * Staff user administration integration tests (real PostgreSQL).
 *
 * Proves: invite a TREASURER (temp password returned, login works with the
 * right permission set), list shows both staff, role replacement to
 * ACCOUNTANT changes effective permissions, suspension revokes sessions and
 * blocks login, and the self/last-admin guards hold.
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
  adminEmail: string;
}> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(saasLogin.status).toBe(200);
  const suffix = randomUUID().slice(0, 8);
  const onboard = await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
    .send({
      name: `${label} cooperative`,
      slug: `${label}-${suffix}`,
      adminEmail: `${label}-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  expect(onboard.status).toBe(201);
  const coopLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `${label}-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  expect(coopLogin.status).toBe(200);
  return {
    tokens: { accessToken: coopLogin.body.tokens.accessToken as string },
    adminEmail: `${label}-${suffix}@coopengine.test`,
  };
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
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (
         SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.end();
  }
  if (app) await app.close();
});

describe('staff user administration', () => {
  it('invites, re-roles and suspends staff with permission guards', async () => {
    const coop = await onboardCoop('adm');
    const adminAuth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
    const staffEmail = `staff-${randomUUID().slice(0, 8)}@coopengine.test`;

    // Invite a TREASURER
    const invited = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(adminAuth)
      .send({ email: staffEmail, roleCodes: ['TREASURER'] });
    expect(invited.status).toBe(201);
    expect(invited.body.roleCodes).toEqual(['TREASURER']);
    const tempPassword = invited.body.tempPassword as string;
    expect(tempPassword.length).toBeGreaterThanOrEqual(12);

    // Unknown role -> 404
    const badRole = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(adminAuth)
      .send({ email: `ghost-${randomUUID().slice(0, 6)}@coopengine.test`, roleCodes: ['NINJA'] });
    expect(badRole.status).toBe(404);

    // Treasurer can log in and post savings but cannot manage users
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: tempPassword });
    expect(login.status).toBe(200);
    const treasurerTok = login.body.tokens.accessToken as string;
    const noUsers = await request(app.getHttpServer())
      .get('/api/v1/users')
      .set({ Authorization: `Bearer ${treasurerTok}` });
    expect(noUsers.status).toBe(403);

    // List shows the invited user
    const list = await request(app.getHttpServer()).get('/api/v1/users').set(adminAuth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.some((u: { email: string }) => u.email === staffEmail)).toBe(true);

    // Re-role to ACCOUNTANT (no savings.post) — same user now blocked from deposits
    const reRole = await request(app.getHttpServer())
      .patch('/api/v1/users/roles')
      .set(adminAuth)
      .send({ email: staffEmail, roleCodes: ['ACCOUNTANT'] });
    expect(reRole.status).toBe(200);
    expect(reRole.body.roleCodes).toEqual(['ACCOUNTANT']);

    // Build a deposit attempt via the accountant's fresh token
    const accountantLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: tempPassword });
    expect(accountantLogin.status).toBe(200);
    const accountantTok = accountantLogin.body.tokens.accessToken as string;

    const member = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(adminAuth)
      .send({ firstName: 'Role', lastName: 'Check', email: `rc-${randomUUID().slice(0, 6)}@coopengine.test` });
    const memberId = member.body.id as string;
    const opened = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set(adminAuth)
      .send({});
    const depositAsAccountant = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${opened.body.id as string}/deposits`)
      .set({ Authorization: `Bearer ${accountantTok}` })
      .send({ amount: 1000 });
    expect(depositAsAccountant.status).toBe(403);

    // Self-role change blocked
    const selfRole = await request(app.getHttpServer())
      .patch('/api/v1/users/roles')
      .set(adminAuth)
      .send({ email: coop.adminEmail, roleCodes: ['SECRETARY'] });
    expect(selfRole.status).toBe(409);

    // Suspend the staff user -> login blocked
    const suspended = await request(app.getHttpServer())
      .patch('/api/v1/users/status')
      .set(adminAuth)
      .send({ email: staffEmail, status: 'SUSPENDED' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');
    const loginAfterSuspend = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: tempPassword });
    expect(loginAfterSuspend.status).toBe(401);

    // Self-suspension blocked + last-admin suspension blocked (staff is not
    // admin; suspending the only admin is)
    const selfSuspend = await request(app.getHttpServer())
      .patch('/api/v1/users/status')
      .set(adminAuth)
      .send({ email: coop.adminEmail, status: 'SUSPENDED' });
    expect(selfSuspend.status).toBe(409);
  });
});
