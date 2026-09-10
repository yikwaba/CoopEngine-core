/**
 * Dividends, member statements and guarantor self-acceptance (real PostgreSQL).
 *
 * Proves: pro-rata dividend preview (exact totals), idempotent posting with a
 * balanced journal, savings credits for every allocation, the run register,
 * consolidated member statements (JSON + CSV), and the guarantor consent flow
 * (decline removes a guarantor from the approval gate).
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

interface Coop {
  tokens: { accessToken: string };
  slug: string;
}

async function onboardCoop(label: string): Promise<Coop> {
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
    slug: `${label}-${suffix}`,
  };
}

async function createActiveMember(
  coop: Coop,
  seed: string,
): Promise<{ id: string; email: string }> {
  const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };
  const email = `dv-${seed}-${randomUUID().slice(0, 6)}@coopengine.test`;
  const created = await request(app.getHttpServer())
    .post('/api/v1/members')
    .set(auth)
    .send({ firstName: `Div${seed}`, lastName: 'Member', email });
  expect(created.status).toBe(201);
  const id = (created.body.id ?? created.body.member?.id) as string;
  const approved = await request(app.getHttpServer())
    .post(`/api/v1/members/${id}/approve`)
    .set(auth)
    .send({});
  expect(approved.status).toBe(200);
  return { id, email };
}

async function memberLogin(coop: Coop, email: string): Promise<string> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/member/request-otp')
    .send({ organizationSlug: coop.slug, email });
  expect(otp.status).toBe(200);
  const verify = await request(app.getHttpServer())
    .post('/api/v1/auth/member/verify-otp')
    .send({ organizationSlug: coop.slug, email, code: otp.body.devCode });
  expect(verify.status).toBe(200);
  return verify.body.accessToken as string;
}

describe('dividends, statements and guarantor consent', () => {
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

  it('distributes surplus pro-rata and reconciles the books', async () => {
    const coop = await onboardCoop('dv');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const a = await createActiveMember(coop, 'A');
    const b = await createActiveMember(coop, 'B');

    // Buy shares: A 30,000 · B 10,000 (3:1 split)
    for (const [memberId, amount] of [
      [a.id, 30000],
      [b.id, 10000],
    ] as [string, number][]) {
      const buy = await request(app.getHttpServer())
        .post(`/api/v1/shares/member/${memberId}/purchases`)
        .set(auth)
        .send({ amount, idempotencyKey: randomUUID() });
      expect([200, 201]).toContain(buy.status);
    }

    // Preview: 100,000 surplus → 75,000 / 25,000 and an exact total
    const preview = await request(app.getHttpServer())
      .get('/api/v1/dividends/preview?period=2026&amount=100000')
      .set(auth);
    expect(preview.status).toBe(200);
    const previewTotal = preview.body.allocations.reduce(
      (sum: number, x: { amount: number }) => sum + x.amount,
      0,
    );
    expect(Math.round(previewTotal * 100) / 100).toBe(100000);
    const previewA = preview.body.allocations.find(
      (x: { memberId: string }) => x.memberId === a.id,
    );
    expect(previewA.amount).toBe(75000);

    // Post (idempotent per org+period)
    const posted = await request(app.getHttpServer())
      .post('/api/v1/dividends/post')
      .set(auth)
      .send({ periodLabel: '2026', distributableAmount: 100000 });
    expect(posted.status).toBe(201);
    expect(posted.body.total).toBe(100000);
    expect(posted.body.members).toBe(2);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/dividends/post')
      .set(auth)
      .send({ periodLabel: '2026', distributableAmount: 100000 });
    expect(replay.status).toBe(409);

    // Runs register + allocations
    const runs = await request(app.getHttpServer()).get('/api/v1/dividends').set(auth);
    expect(runs.status).toBe(200);
    expect(runs.body).toHaveLength(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/dividends/${runs.body[0].id}`)
      .set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.allocations).toHaveLength(2);

    // Members' savings were credited
    const savings = await request(app.getHttpServer())
      .get(`/api/v1/reports/member/${a.id}/360`)
      .set(auth);
    expect(savings.status).toBe(200);
    expect(savings.body.savingsTotal).toBe(75000);

    // Member statement (JSON + CSV)
    const statement = await request(app.getHttpServer())
      .get(`/api/v1/reports/member/${a.id}/statement`)
      .set(auth);
    expect(statement.status).toBe(200);
    expect(statement.body.dividends[0].amount).toBe(75000);
    expect(statement.body.shareTransactions.length).toBeGreaterThan(0);

    const csv = await request(app.getHttpServer())
      .get(`/api/v1/reports/export/member-statement?memberId=${a.id}`)
      .set(auth);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('section,date,description,amount');
    expect(csv.text).toContain('dividend');

    // Books stay balanced
    const net = await pool.query(`SELECT coalesce(sum(debit - credit), 0) AS net FROM journal_lines`);
    expect(Number(net.rows[0].net)).toBe(0);
  });

  it('honours guarantor consent in the approval gate', async () => {
    const coop = await onboardCoop('gc');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const borrower = await createActiveMember(coop, 'BOR');
    const g1 = await createActiveMember(coop, 'G1');
    const g2 = await createActiveMember(coop, 'G2');

    // Fund the borrower so the savings-multiple cap allows the loan
    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${borrower.id}/account`)
      .set(auth)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 30000, idempotencyKey: randomUUID() });

    const loan = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({
        memberId: borrower.id,
        productId: (
          await request(app.getHttpServer()).get('/api/v1/loans/products').set(auth)
        ).body[0].id,
        principal: 30000,
        termMonths: 3,
        guarantorIds: [g1.id, g2.id],
      });
    expect(loan.status).toBe(201);
    const loanId = loan.body.id as string;

    // g1 declines their request
    const g1Token = await memberLogin(coop, g1.email);
    const requests = await request(app.getHttpServer())
      .get('/api/v1/member/guarantor-requests')
      .set({ Authorization: `Bearer ${g1Token}` });
    expect(requests.status).toBe(200);
    const mine = requests.body.find((r: { loanId: string }) => r.loanId === loanId);
    expect(mine).toBeTruthy();
    const declined = await request(app.getHttpServer())
      .post(`/api/v1/member/guarantor-requests/${mine.id}/respond`)
      .set({ Authorization: `Bearer ${g1Token}` })
      .send({ accept: false });
    expect(declined.status).toBe(201);
    expect(declined.body.status).toBe('REJECTED');

    // Only one non-rejected guarantor remains → approval blocked
    const blocked = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/approve`)
      .set(auth);
    expect(blocked.status).toBe(409);

    // Staff replaces the declined guarantor
    const g3 = await createActiveMember(coop, 'G3');
    const replaced = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/guarantors`)
      .set(auth)
      .send({ memberId: g3.id });
    expect(replaced.status).toBe(201);

    // g2 accepts → approval succeeds
    const g2Token = await memberLogin(coop, g2.email);
    const g2Requests = await request(app.getHttpServer())
      .get('/api/v1/member/guarantor-requests')
      .set({ Authorization: `Bearer ${g2Token}` });
    const g2Mine = g2Requests.body.find((r: { loanId: string }) => r.loanId === loanId);
    const accepted = await request(app.getHttpServer())
      .post(`/api/v1/member/guarantor-requests/${g2Mine.id}/respond`)
      .set({ Authorization: `Bearer ${g2Token}` })
      .send({ accept: true });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('APPROVED');

    const approved = await request(app.getHttpServer())
      .post(`/api/v1/loans/${loanId}/approve`)
      .set(auth);
    expect(approved.status).toBe(200);
  });
});

