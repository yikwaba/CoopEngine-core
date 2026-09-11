/**
 * Savings withdrawal approvals (maker-checker) — real PostgreSQL.
 *
 * Proves the organisation policy is enforced on every withdrawal path, that a
 * request cannot be approved by its own author, that approval posts through the
 * ledger exactly once, and that member self-service requests always need staff.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
let app: INestApplication;
let pool: Pool;

describe('savings withdrawal approvals', () => {
  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE user_id IN
      (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.end();
    await app.close();
  });

  it('enforces the approval policy, keeps books balanced and blocks self-approval', async () => {
    // ---- setup: a cooperative with one funded member ---------------------
    const saasLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const suffix = randomUUID().slice(0, 8);
    await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
      .send({
        name: 'approvals cooperative',
        slug: `appr-${suffix}`,
        adminEmail: `appr-${suffix}@coopengine.test`,
        adminPassword: 'CoopPass123!',
      });
    const officerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `appr-${suffix}@coopengine.test`, password: 'CoopPass123!' });
    const officer = { Authorization: `Bearer ${officerLogin.body.tokens.accessToken}` };

    // a second staff member who may approve
    const approverEmail = `approver-${suffix}@coopengine.test`;
    const invited = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(officer)
      .send({ email: approverEmail, roleCodes: ['TREASURER'] });
    expect(invited.status).toBe(201);
    const approverLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: approverEmail, password: invited.body.tempPassword });
    const approver = { Authorization: `Bearer ${approverLogin.body.tokens.accessToken}` };

    // member + savings account funded with 100,000
    const memberEmail = `wd-${suffix}@coopengine.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(officer)
      .send({ firstName: 'With', lastName: 'Drawer', email: memberEmail, phone: '+2348030000000' });
    const memberId = (created.body.id ?? created.body.member?.id) as string;
    await request(app.getHttpServer()).post(`/api/v1/members/${memberId}/approve`).set(officer).send({});
    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set(officer)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(officer)
      .send({ amount: 100000, description: 'opening deposit' });

    const balanceOf = async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/reports/savings-book').set(officer);
      const row = res.body.rows.find((r: { memberId: string }) => r.memberId === memberId);
      return Number(row.balance);
    };
    expect(await balanceOf()).toBe(100000);

    // ---- 1. no policy: withdrawal posts immediately -----------------------
    const direct = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/withdrawals`)
      .set(officer)
      .send({ amount: 10000, description: 'cash at counter' });
    expect(direct.status).toBe(200);
    expect(await balanceOf()).toBe(90000);

    // ---- 2. policy: above the threshold needs approval --------------------
    const setPolicy = await request(app.getHttpServer())
      .patch('/api/v1/savings/settings/withdrawal-approval')
      .set(officer)
      .send({ threshold: 5000 });
    expect(setPolicy.status).toBe(200);
    expect(setPolicy.body.threshold).toBe(5000);

    const parked = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/withdrawals`)
      .set(officer)
      .send({ amount: 25000, description: 'school fees' });
    expect(parked.status).toBe(200);
    expect(parked.body.kind).toBe('PENDING');
    const requestId = parked.body.requestId as string;
    expect(await balanceOf()).toBe(90000); // nothing moved yet

    const pending = await request(app.getHttpServer())
      .get('/api/v1/savings/withdrawals?status=PENDING')
      .set(officer);
    expect(pending.body.some((r: { id: string }) => r.id === requestId)).toBe(true);

    // ---- 3. segregation of duties ----------------------------------------
    const selfApprove = await request(app.getHttpServer())
      .post(`/api/v1/savings/withdrawals/${requestId}/approve`)
      .set(officer)
      .send({});
    expect(selfApprove.status).toBe(409);
    expect(await balanceOf()).toBe(90000);

    // ---- 4. a different approver posts it, once ---------------------------
    const approved = await request(app.getHttpServer())
      .post(`/api/v1/savings/withdrawals/${requestId}/approve`)
      .set(approver)
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.journalEntryId).toBeTruthy();
    expect(await balanceOf()).toBe(65000);

    const replay = await request(app.getHttpServer())
      .post(`/api/v1/savings/withdrawals/${requestId}/approve`)
      .set(approver)
      .send({});
    expect(replay.status).toBe(409);
    expect(await balanceOf()).toBe(65000); // never pays twice

    // ---- 5. rejection leaves the money alone -----------------------------
    const parked2 = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/withdrawals`)
      .set(officer)
      .send({ amount: 6000, description: 'transport' });
    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/savings/withdrawals/${parked2.body.requestId}/reject`)
      .set(approver)
      .send({ notes: 'needs committee minutes' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('REJECTED');
    expect(await balanceOf()).toBe(65000);

    // ---- 6. member self-service always needs staff approval ---------------
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: `appr-${suffix}`, email: memberEmail });

    const memberLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: `appr-${suffix}`, email: memberEmail, code: otp.body.devCode });
    const memberToken = (memberLogin.body.accessToken ??
      memberLogin.body.tokens?.accessToken) as string;
    const member = { Authorization: `Bearer ${memberToken}` };

    const memberReq = await request(app.getHttpServer())
      .post('/api/v1/member/withdrawals/request')
      .set(member)
      .send({ accountId, amount: 1000, description: 'personal need' });
    expect(memberReq.status).toBe(201);
    expect(memberReq.body.kind).toBe('PENDING');
    expect(await balanceOf()).toBe(65000);

    const mine = await request(app.getHttpServer()).get('/api/v1/member/withdrawals').set(member);
    expect(mine.body.some((r: { status: string }) => r.status === 'PENDING')).toBe(true);

    // a member token cannot approve anything
    const memberApproves = await request(app.getHttpServer())
      .post(`/api/v1/savings/withdrawals/${memberReq.body.requestId}/approve`)
      .set(member)
      .send({});
    expect([401, 403]).toContain(memberApproves.status);

    // ---- 7. the ledger still balances ------------------------------------
    const tb = await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(officer);
    expect(Number(tb.body.net)).toBe(0);
  });
});
