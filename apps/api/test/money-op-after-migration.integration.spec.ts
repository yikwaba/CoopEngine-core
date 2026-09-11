/**
 * Money operations immediately after an opening-balance import.
 *
 * Regression guard: the opening-balance migration used to allocate its journal
 * entry number with max(entry_no)+1 without advancing org_counters, so the next
 * deposit or repayment asked for a number the batch had already taken and died
 * with a unique-constraint error (HTTP 500). Importing balances and then
 * collecting is the pilot's first day, so this must never break again.
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
const ADMIN = { email: `mop-admin-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const MEMBER_A = `mop-a-${suffix}@coopengine.test`;
const MEMBER_B = `mop-b-${suffix}@coopengine.test`;

describe('money operations after an opening-balance import', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let token = '';
  let orgId = '';
  let accountA = '';
  let migratedLoanId = '';

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const slug = `mop-${suffix}`;
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `MoneyOp ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    token = login.body.tokens.accessToken as string;
    orgId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).org as string;

    for (const [first, email, phone] of [
      ['Ada', MEMBER_A, '+2348031110001'],
      ['Bola', MEMBER_B, '+2348031110002'],
    ]) {
      const created = await http
        .post('/api/v1/members')
        .set({ Authorization: `Bearer ${token}` })
        .send({ firstName: first, lastName: 'Tester', email, phone, joinedOn: '2026-01-10' })
        .expect(201);
      await http
        .post(`/api/v1/members/${created.body.id}/approve`)
        .set({ Authorization: `Bearer ${token}` })
        .send({})
        .expect(200);
    }

    // Import balances: savings for both, plus one loan already in arrears.
    const csv = [
      'memberEmail,savings,shares,loanOutstanding,loanTermMonths,loanRatePa,loanDaysLate,loanPaidCount,loanPrincipal,loanLastPaymentDate',
      `${MEMBER_A},150000.00,25000.00,,0,0,,,,`,
      `${MEMBER_B},90000.00,15000.00,80000.00,12,15,20,4,120000.00,2026-08-15`,
    ].join('\n');
    const preview = await http
      .post('/api/v1/migrations/opening-balances/preview')
      .set({ Authorization: `Bearer ${token}` })
      .send({ label: 'regression batch', filename: 'batch.csv', csv: `${csv}\n` });
    expect(preview.status).toBe(201);
    expect(preview.body.totals.valid).toBe(2);
    await http
      .post(`/api/v1/migrations/opening-balances/${preview.body.batchId}/commit`)
      .set({ Authorization: `Bearer ${token}` })
      .send({})
      .expect(201);

    const members = await http.get('/api/v1/members?limit=10').set({ Authorization: `Bearer ${token}` });
    const a = members.body.find((m: { email: string }) => m.email === MEMBER_A);
    const accounts = await http
      .get(`/api/v1/savings/member/${a.id}/accounts`)
      .set({ Authorization: `Bearer ${token}` });
    accountA = (accounts.body[0] ?? accounts.body.items?.[0]).id as string;

    const loans = await http.get('/api/v1/loans?limit=10').set({ Authorization: `Bearer ${token}` });
    migratedLoanId = loans.body[0].id as string;
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it('accepts a deposit straight after the import', async () => {
    const res = await http
      .post(`/api/v1/savings/accounts/${accountA}/deposits`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ amount: 7500, description: 'first collection after migration' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(Number(res.body.currentBalance)).toBe(157500);
  });

  it('accepts a repayment on a migrated loan', async () => {
    const res = await http
      .post(`/api/v1/loans/${migratedLoanId}/repayments`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ amount: 10000, description: 'first repayment after migration' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });

  it('never issues the same journal number twice', async () => {
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [orgId]);
      const dup = await client.query(
        `SELECT entry_no, count(*)::int AS n FROM journal_entries
          WHERE organization_id = $1 GROUP BY entry_no HAVING count(*) > 1`,
        [orgId],
      );
      expect(dup.rows).toEqual([]);
      const total = await client.query(
        `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`,
        [orgId],
      );
      expect(total.rows[0].n).toBeGreaterThanOrEqual(3);

      // The counter must be at least as high as the highest entry used.
      const counter = await client.query(
        `SELECT journal_seq, (SELECT max(entry_no) FROM journal_entries WHERE organization_id = $1) AS max_no
           FROM org_counters WHERE organization_id = $1`,
        [orgId],
      );
      expect(Number(counter.rows[0].journal_seq)).toBeGreaterThanOrEqual(Number(counter.rows[0].max_no));
    } finally {
      client.release();
    }
  });
});
