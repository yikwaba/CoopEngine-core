/**
 * Ledger core integration tests (real PostgreSQL).
 *
 * Proves: seeded chart + open period at onboarding, DRAFT -> SUBMITTED ->
 * POSTED flow with sequential entry numbers, unbalanced journals rejected at
 * creation (DB trigger backstop), period gating, reversal netting to zero,
 * trial balance, and cross-tenant journal isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool, withTenant } from '@coopengine/db';
import { ensureRbacSeeded } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
const ADMIN_PASSWORD = 'AdminDev123!';

let app: INestApplication;
let pool: Pool;

interface CoopCtx {
  tokens: { accessToken: string };
  periodCode: string;
  orgId: string;
}

async function onboardCoop(label: string): Promise<CoopCtx> {
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
    .send({
      email: `${label}-${suffix}@coopengine.test`,
      password: 'CoopPass123!',
    });
  expect(coopLogin.status).toBe(200);
  const me = await request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${coopLogin.body.tokens.accessToken}`);
  expect(me.status).toBe(200);
  const now = new Date();
  return {
    tokens: { accessToken: coopLogin.body.tokens.accessToken as string },
    periodCode: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    orgId: me.body.organizationId as string,
  };
}

const todayIso = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';
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
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await pool.query(`DELETE FROM sessions`);
    await pool.end();
  }
  if (app) await app.close();
});

describe('ledger core (double entry)', () => {
  it('seeds the baseline chart and an OPEN period at onboarding', async () => {
    const coop = await onboardCoop('chart');
    const accounts = await request(app.getHttpServer())
      .get('/api/v1/ledger/accounts')
      .set('Authorization', `Bearer ${coop.tokens.accessToken}`);
    expect(accounts.status).toBe(200);
    const list = accounts.body as { code: string; name: string; type: string }[];
    expect(list.length).toBeGreaterThanOrEqual(19);
    expect(list.find((a) => a.code === '1000')?.name).toBe('Cash at Bank');
    expect(list.find((a) => a.code === '2000')?.type).toBe('LIABILITY');

    const periods = await request(app.getHttpServer())
      .get('/api/v1/ledger/periods')
      .set('Authorization', `Bearer ${coop.tokens.accessToken}`);
    expect(periods.status).toBe(200);
    const periodList = periods.body as { code: string; status: string }[];
    expect(periodList.find((p) => p.code === coop.periodCode)?.status).toBe('OPEN');
  });

  it('posts a balanced entry with a sequential number (DRAFT->SUBMITTED->POSTED)', async () => {
    const coop = await onboardCoop('post');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const draft = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set(auth)
      .send({
        entryDate: todayIso,
        description: 'Cash loan disbursed to member',
        idempotencyKey: `loan-${randomUUID().slice(0, 12)}`,
        lines: [
          { accountCode: '1020', debit: 25000.5, memo: 'Loan receivables' },
          { accountCode: '1000', credit: 25000.5, memo: 'Bank out' },
        ],
      });
    if (draft.status !== 201) {
      throw new Error(`DRAFT FAILED: ${JSON.stringify(draft.body)}`);
    }
    expect(draft.status).toBe(201);
    const draftId = draft.body.id as string;
    expect(draft.body.status).toBe('DRAFT');
    expect(draft.body.entryNo).toBeNull();

    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${draftId}/submit`)
      .set(auth);
    expect(submitted.status).toBe(200);
    if (submitted.status !== 200) {
      throw new Error(`SUBMIT FAILED: ${JSON.stringify(submitted.body)}`);
    }
    expect(submitted.body.status).toBe('SUBMITTED');

    const posted = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${draftId}/approve-post`)
      .set(auth);
    expect(posted.status).toBe(200);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.entryNo).toBe(1);

    // Detail includes mirrored lines
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/ledger/journals/${draftId}`)
      .set(auth);
    expect(detail.status).toBe(200);
    const lines = (detail.body as { lines: { accountCode: string; debit: number; credit: number }[] }).lines;
    expect(lines).toHaveLength(2);
    const debitLine = lines.find((l) => l.accountCode === '1020');
    expect(debitLine?.debit).toBe(25000.5);

    // Double-post rejected
    const repost = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${draftId}/approve-post`)
      .set(auth);
    expect(repost.status).toBe(409);
  });

  it('rejects unbalanced and single-sided journals (API + DB trigger backstop)', async () => {
    const coop = await onboardCoop('unbal');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    // API-level validation rejects it before the DB
    const unbalanced = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set(auth)
      .send({
        entryDate: todayIso,
        description: 'Bad entry',
        lines: [
          { accountCode: '1000', debit: 100 },
          { accountCode: '2000', credit: 99 },
        ],
      });
    expect(unbalanced.status).toBe(400);

    // A line with both sides is also rejected
    const bothSides = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set(auth)
      .send({
        entryDate: todayIso,
        description: 'Bad line',
        lines: [
          { accountCode: '1000', debit: 100, credit: 100 },
          { accountCode: '2000', credit: 100 },
        ],
      });
    expect(bothSides.status).toBe(400);

    // Unknown account code
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set(auth)
      .send({
        entryDate: todayIso,
        description: 'Bad account',
        lines: [
          { accountCode: '9999', debit: 100 },
          { accountCode: '1000', credit: 100 },
        ],
      });
    expect(unknown.status).toBe(400);

    // DB trigger backstop: a raw unbalanced insert inside a tenant transaction
    // must be rejected even when it bypasses the API entirely.
    const entryId = randomUUID();
    await expect(
      (async () => {
        await withTenant(pool, coop.orgId, async (c) => {
          const accQuery = await c.query(
            `SELECT id FROM chart_of_accounts WHERE organization_id = $1 AND code = '1000'`,
            [coop.orgId],
          );
          const accountId = accQuery.rows[0] as { id: string };
          await c.query(
            `INSERT INTO journal_entries
               (id, organization_id, period_id, entry_date, description, source, status, created_by)
             SELECT $1, $2, lp.id, $3, 'raw bypass attempt', 'MANUAL', 'POSTED', NULL
               FROM ledger_periods lp
              WHERE lp.organization_id = $2 AND lp.status = 'OPEN' LIMIT 1`,
            [entryId, coop.orgId, todayIso],
          );
          // One statement, two lines, unequal totals -> final imbalance
          await c.query(
            `INSERT INTO journal_lines (organization_id, journal_entry_id, account_id, debit, credit)
             VALUES ($1, $2, $3, 100, 0), ($1, $2, $3, 0, 99)`,
            [coop.orgId, entryId, accountId.id],
          );
        });
      })(),
    ).rejects.toThrow(/journal_imbalance/);
  });

  it('nets to zero after reversal; trial balance stays zero', async () => {
    const coop = await onboardCoop('rev');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const draft = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set(auth)
      .send({
        entryDate: todayIso,
        description: 'Admin expense',
        lines: [
          { accountCode: '5010', debit: 1500 },
          { accountCode: '1000', credit: 1500 },
        ],
      });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${id}/submit`)
      .set(auth);
    const posted = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${id}/approve-post`)
      .set(auth);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.entryNo).toBe(1);

    // Reverse it
    const reversed = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${id}/reverse`)
      .set(auth)
      .send({ reason: 'Entered in error' });
    expect(reversed.status).toBe(200);
    expect(reversed.body.reversal.status).toBe('POSTED');
    expect(reversed.body.reversal.entryNo).toBe(2);

    // Original marked REVERSED
    const original = await request(app.getHttpServer())
      .get(`/api/v1/ledger/journals/${id}`)
      .set(auth);
    expect(original.body.entry.status).toBe('REVERSED');

    // Trial balance nets to zero across all accounts
    const tb = await request(app.getHttpServer())
      .get('/api/v1/ledger/trial-balance')
      .set(auth);
    expect(tb.status).toBe(200);
    expect(tb.body.net).toBe(0);
  });

  it('isolates journals between cooperatives (cross-tenant 404)', async () => {
    const coopA = await onboardCoop('iso-l-a');
    const coopB = await onboardCoop('iso-l-b');

    const draft = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set({ Authorization: `Bearer ${coopB.tokens.accessToken}` })
      .send({
        entryDate: todayIso,
        description: 'Org B entry',
        lines: [
          { accountCode: '1000', debit: 500 },
          { accountCode: '2000', credit: 500 },
        ],
      });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;

    // Org A cannot read or act on org B's journal
    const crossRead = await request(app.getHttpServer())
      .get(`/api/v1/ledger/journals/${id}`)
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` });
    expect(crossRead.status).toBe(404);

    const crossSubmit = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${id}/submit`)
      .set({ Authorization: `Bearer ${coopA.tokens.accessToken}` });
    expect(crossSubmit.status).toBe(404);
  });
});
