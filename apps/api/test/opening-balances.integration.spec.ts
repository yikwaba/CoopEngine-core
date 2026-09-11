/**
 * Opening-balance migration (real PostgreSQL).
 *
 * Proves a cooperative can bring existing balances across: CSV preview with
 * per-row validation, one balanced opening journal, member savings and share
 * balances, legacy loans recreated as DISBURSED with a schedule, idempotency
 * (one posting per batch) and tenant isolation.
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

async function onboardCoop(label: string): Promise<{ tokens: { accessToken: string }; slug: string }> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const suffix = randomUUID().slice(0, 8);
  await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
    .send({
      name: `${label} cooperative`,
      slug: `${label}-${suffix}`,
      adminEmail: `${label}-${suffix}@coopengine.test`,
      adminPassword: 'CoopPass123!',
    });
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: `${label}-${suffix}@coopengine.test`, password: 'CoopPass123!' });
  return { tokens: { accessToken: login.body.tokens.accessToken as string }, slug: `${label}-${suffix}` };
}

describe('opening balance migration', () => {
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

  it('migrates savings, shares and legacy loans with one balanced journal', async () => {
    const coop = await onboardCoop('ob');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const mk = async (first: string, last: string) => {
      const email = `ob-${first.toLowerCase()}-${randomUUID().slice(0, 6)}@coopengine.test`;
      const created = await request(app.getHttpServer())
        .post('/api/v1/members')
        .set(auth)
        .send({ firstName: first, lastName: last, email, phone: '+2348030000000' });
      const id = (created.body.id ?? created.body.member?.id) as string;
      await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth).send({});
      return { id, email };
    };

    const ada = await mk('Ada', 'Migrated');
    const bola = await mk('Bola', 'Migrated');

    const csv = [
      'memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa',
      `${ada.email},50000,10000,0,,`,
      `${bola.email},0,0,20000,6,15`,
      `nobody-${randomUUID().slice(0, 6)}@example.com,1000,0,0,,`,
      `${ada.email},-500,0,0,,`,
    ].join('\n');

    // --- preview ---------------------------------------------------------
    const preview = await request(app.getHttpServer())
      .post('/api/v1/migrations/opening-balances/preview')
      .set(auth)
      .send({ label: 'Legacy balances 2026', filename: 'legacy.csv', csv });
    expect(preview.status).toBe(201);
    expect(preview.body.totals).toEqual({ rows: 4, valid: 2, invalid: 2 });
    expect(preview.body.validTotals).toEqual({ savings: 50000, shares: 10000, loans: 20000 });
    const invalidReasons = preview.body.rows
      .filter((r: { errors: string[] }) => r.errors.length > 0)
      .flatMap((r: { errors: string[] }) => r.errors);
    expect(invalidReasons.some((e: string) => e.includes('no member matches'))).toBe(true);
    expect(invalidReasons.some((e: string) => e.includes('cannot be negative'))).toBe(true);
    const batchId = preview.body.batchId as string;
    expect(batchId).toBeTruthy();

    // missing required column is rejected outright
    const badCsv = await request(app.getHttpServer())
      .post('/api/v1/migrations/opening-balances/preview')
      .set(auth)
      .send({ label: 'bad', csv: 'foo,bar\n1,2' });
    expect(badCsv.status).toBe(400);

    // --- commit ----------------------------------------------------------
    const commit = await request(app.getHttpServer())
      .post(`/api/v1/migrations/opening-balances/${batchId}/commit`)
      .set(auth)
      .send({});
    expect(commit.status).toBe(201);
    expect(commit.body).toMatchObject({ members: 2, savings: 50000, shares: 10000, loans: 20000 });
    expect(commit.body.entryNo).toBeGreaterThan(0);

    // --- effects: savings book -------------------------------------------
    const book = await request(app.getHttpServer()).get('/api/v1/reports/savings-book').set(auth);
    expect(book.status, `body=${JSON.stringify(book.body).slice(0, 300)}`).toBe(200);
    expect(book.body, `keys=${Object.keys(book.body).join(',')}`).toHaveProperty('rows');
    const adaRow = book.body.rows.find((r: { memberName: string }) => r.memberName.includes('Ada'));
    expect(adaRow).toBeTruthy();
    expect(Number(adaRow.balance)).toBe(50000);

    // --- effects: legacy loan is live with a schedule ---------------------
    const loans = await request(app.getHttpServer()).get('/api/v1/loans').set(auth);
    const loanRows = loans.body as {
      memberId?: string;
      id: string;
      status: string;
      outstandingPrincipal?: number;
      termMonths?: number;
    }[];
    const legacyLoan = loanRows.find(
      (l) => l.memberId === bola.id || Number(l.outstandingPrincipal) === 20000,
    );
    expect(legacyLoan).toBeTruthy();
    expect(legacyLoan.status).toBe('DISBURSED');
    expect(Number(legacyLoan.outstandingPrincipal)).toBe(20000);
    expect(Number(legacyLoan.termMonths)).toBe(6);
    const schedule = await request(app.getHttpServer())
      .get(`/api/v1/loans/${legacyLoan.id}/schedule`)
      .set(auth);
    expect(schedule.body).toHaveLength(6);
    const principalDue = schedule.body.reduce(
      (s: number, r: { principalDue: number }) => s + Number(r.principalDue),
      0,
    );
    expect(Math.round(principalDue * 100) / 100).toBe(20000);

    // --- books stay balanced ---------------------------------------------
    const tb = await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(auth);
    expect(tb.status, `tb body=${JSON.stringify(tb.body).slice(0, 200)}`).toBe(200);
    // the service reports the balanced-books invariant directly
    expect(Number(tb.body.net)).toBe(0);
    expect((tb.body.rows ?? []).length).toBeGreaterThan(0);

    // --- idempotency + audit ---------------------------------------------
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/migrations/opening-balances/${batchId}/commit`)
      .set(auth)
      .send({});
    expect(replay.status).toBe(409);

    const list = await request(app.getHttpServer())
      .get('/api/v1/migrations/opening-balances')
      .set(auth);
    expect(list.body[0].status).toBe('POSTED');
    expect(list.body[0].memberCount).toBe(2);

    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action IN ('migration.opening_balances.previewed','migration.opening_balances.posted')`,
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);

    // --- tenant isolation -------------------------------------------------
    const other = await onboardCoop('ob2');
    const foreign = await request(app.getHttpServer())
      .get(`/api/v1/migrations/opening-balances/${batchId}`)
      .set({ Authorization: `Bearer ${other.tokens.accessToken}` });
    expect(foreign.status).toBe(404);
  });

  it('carries past-due flags across (arrears ageing + auto-default)', async () => {
    const coop = await onboardCoop('oblate');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const mk = async (first: string) => {
      const email = `late-${first.toLowerCase()}-${randomUUID().slice(0, 6)}@coopengine.test`;
      const created = await request(app.getHttpServer())
        .post('/api/v1/members')
        .set(auth)
        .send({ firstName: first, lastName: 'Behind', email, phone: '+2348030000000' });
      const id = (created.body.id ?? created.body.member?.id) as string;
      await request(app.getHttpServer()).post(`/api/v1/members/${id}/approve`).set(auth).send({});
      return { id, email };
    };

    const mild = await mk('Mild');
    const severe = await mk('Severe');

    const csv = [
      'memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa,loanDaysLate,loanArrearsAmount',
      `${mild.email},0,0,20000,6,15,45,5000`,
      `${severe.email},0,0,10000,12,15,120,10000`,
    ].join('\n');

    const preview = await request(app.getHttpServer())
      .post('/api/v1/migrations/opening-balances/preview')
      .set(auth)
      .send({ label: 'Legacy balances with arrears', csv });
    expect(preview.status).toBe(201);
    expect(preview.body.totals).toEqual({ rows: 2, valid: 2, invalid: 0 });
    const lateRow = preview.body.rows.find((r: { memberRef: string }) => r.memberRef === mild.email);
    expect(lateRow.loanDaysLate).toBe(45);
    expect(lateRow.loanArrearsAmount).toBe(5000);

    const commit = await request(app.getHttpServer())
      .post(`/api/v1/migrations/opening-balances/${preview.body.batchId}/commit`)
      .set(auth)
      .send({});
    expect(commit.status).toBe(201);
    expect(commit.body.loans).toBe(30000);

    const loans = (await request(app.getHttpServer()).get('/api/v1/loans').set(auth)).body as {
      id: string;
      memberId: string;
      status: string;
      interestMethod?: string;
      outstandingPrincipal: number;
    }[];
    const mildLoan = loans.find((l) => l.memberId === mild.id);
    const severeLoan = loans.find((l) => l.memberId === severe.id);
    // straight-line method, and the 90+ day rule mirrored from the nightly job
    expect(mildLoan?.interestMethod).toBe('FLAT');
    expect(mildLoan?.status).toBe('DISBURSED');
    expect(severeLoan?.status).toBe('DEFAULTED');

    // the schedule is backdated, so the missed instalments show up as arrears
    const arrears = await request(app.getHttpServer()).get('/api/v1/loans/arrears').set(auth);
    expect(arrears.status).toBe(200);
    const mildArrears = arrears.body.rows.filter((r: { loanId: string }) => r.loanId === mildLoan?.id);
    expect(mildArrears.length).toBeGreaterThan(0);
    expect(mildArrears[0].daysLate).toBeGreaterThanOrEqual(31);
    expect(mildArrears[0].daysLate).toBeLessThanOrEqual(75);
    const bucket = arrears.body.buckets.find((b: { bucket: string }) => b.bucket === '31-60');
    expect(bucket.count).toBeGreaterThan(0);
    expect(arrears.body.total).toBeGreaterThan(0);

    // and the books still balance
    const tb = await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(auth);
    expect(Number(tb.body.net)).toBe(0);
  });

});
