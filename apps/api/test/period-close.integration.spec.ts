/**
 * Month-end close: checklist, soft-close, lock (real PostgreSQL).
 *
 * Proves the checklist tells the operator the truth, that a period cannot be
 * closed while journals are unposted, that a closed period refuses new money
 * entries, and that a locked period cannot be reopened.
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

describe('month-end close', () => {
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

  it('walks a period through checklist, soft-close and lock', async () => {
    const saasLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const suffix = randomUUID().slice(0, 8);
    await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
      .send({
        name: 'close cooperative',
        slug: `close-${suffix}`,
        adminEmail: `close-${suffix}@coopengine.test`,
        adminPassword: 'CoopPass123!',
      });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `close-${suffix}@coopengine.test`, password: 'CoopPass123!' });
    const auth = { Authorization: `Bearer ${login.body.tokens.accessToken}` };

    const code = new Date().toISOString().slice(0, 7);

    // a funded member, so the month has real activity
    const memberEmail = `close-member-${suffix}@coopengine.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({ firstName: 'Month', lastName: 'End', email: memberEmail, phone: '+2348030000000' });
    const memberId = (created.body.id ?? created.body.member?.id) as string;
    await request(app.getHttpServer()).post(`/api/v1/members/${memberId}/approve`).set(auth).send({});
    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set(auth)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 25000, description: 'month deposit' });

    // ---- period creation is idempotent -----------------------------------
    const future = await request(app.getHttpServer())
      .post('/api/v1/ledger/periods')
      .set(auth)
      .send({ code: '2031-01' });
    expect(future.status).toBe(201);
    const again = await request(app.getHttpServer())
      .post('/api/v1/ledger/periods')
      .set(auth)
      .send({ code: '2031-01' });
    expect(again.body.id).toBe(future.body.id);

    // ---- baseline checklist ----------------------------------------------
    const clean = await request(app.getHttpServer())
      .get(`/api/v1/ledger/month-end-checklist?period=${code}`)
      .set(auth);
    expect(clean.status).toBe(200);
    expect(clean.body.period.code).toBe(code);
    expect(clean.body.readyToClose).toBe(true);
    const keys = clean.body.checks.map((c: { key: string }) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'balanced',
        'unposted',
        'savings_interest',
        'arrears_reviewed',
        'loan_schedules',
        'negative_balances',
      ]),
    );
    expect(
      clean.body.checks.find((c: { key: string }) => c.key === 'balanced').status,
    ).toBe('ok');

    // ---- an unposted journal blocks the close ----------------------------
    const draft = await request(app.getHttpServer())
      .post('/api/v1/ledger/journals')
      .set(auth)
      .send({
        entryDate: new Date().toISOString().slice(0, 10),
        description: 'Month-end adjustment pending review',
        lines: [
          { accountCode: '1000', debit: 500 },
          { accountCode: '2000', credit: 500 },
        ],
      });
    expect([200, 201], `draft=${JSON.stringify(draft.body).slice(0, 200)}`).toContain(draft.status);
    const draftId = (draft.body.id ?? draft.body.entryId) as string;

    const blocked = await request(app.getHttpServer())
      .get(`/api/v1/ledger/month-end-checklist?period=${code}`)
      .set(auth);
    expect(blocked.body.readyToClose).toBe(false);
    expect(blocked.body.checks.find((c: { key: string }) => c.key === 'unposted').status).toBe('fail');

    // the period cannot be softly closed while that entry is unposted
    const periods = await request(app.getHttpServer()).get('/api/v1/ledger/periods').set(auth);
    const periodList = (periods.body.items ?? periods.body) as { id: string; code: string }[];
    const periodId = periodList.find((p) => p.code === code)?.id as string;
    const refused = await request(app.getHttpServer())
      .patch(`/api/v1/ledger/periods/${periodId}/status`)
      .set(auth)
      .send({ status: 'SOFT_CLOSED' });
    expect(refused.status).toBe(409);

    // ---- post the entry, then close --------------------------------------
    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${draftId}/submit`)
      .set(auth)
      .send({});
    expect([200, 201], `submit=${JSON.stringify(submitted.body).slice(0, 160)}`).toContain(
      submitted.status,
    );
    const posted = await request(app.getHttpServer())
      .post(`/api/v1/ledger/journals/${draftId}/approve-post`)
      .set(auth)
      .send({});
    expect([200, 201]).toContain(posted.status);

    const softClose = await request(app.getHttpServer())
      .patch(`/api/v1/ledger/periods/${periodId}/status`)
      .set(auth)
      .send({ status: 'SOFT_CLOSED' });
    expect(softClose.status).toBe(200);
    expect(softClose.body.status).toBe('SOFT_CLOSED');

    // ---- a closed period refuses new money entries -----------------------
    const afterClose = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 1000, description: 'too late' });
    expect(afterClose.status).toBe(409);

    // ---- reopening lets the cooperative continue -------------------------
    const reopened = await request(app.getHttpServer())
      .patch(`/api/v1/ledger/periods/${periodId}/status`)
      .set(auth)
      .send({ status: 'OPEN' });
    expect(reopened.status).toBe(200);
    const depositAgain = await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 1000, description: 'reopened' });
    expect([200, 201]).toContain(depositAgain.status);

    // ---- locking is final ------------------------------------------------
    const locked = await request(app.getHttpServer())
      .patch(`/api/v1/ledger/periods/${periodId}/status`)
      .set(auth)
      .send({ status: 'LOCKED' });
    expect(locked.status).toBe(200);
    const reopenLocked = await request(app.getHttpServer())
      .patch(`/api/v1/ledger/periods/${periodId}/status`)
      .set(auth)
      .send({ status: 'OPEN' });
    expect(reopenLocked.status).toBe(409);

    // the books still balance after all of it
    const tb = await request(app.getHttpServer()).get('/api/v1/ledger/trial-balance').set(auth);
    expect(Number(tb.body.net)).toBe(0);
  });
});
