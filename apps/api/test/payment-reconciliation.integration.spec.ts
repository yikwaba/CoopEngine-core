/**
 * Payment reconciliation: joining money that arrived to the member and purpose it was for.
 *
 * The properties that matter, and what this spec pins down:
 *   - a transfer quoting an intent's reference posts to that member and closes the intent;
 *   - a transfer nobody can be identified for becomes an exception, and the cash waits in
 *     Unallocated Receipts rather than vanishing or being invented onto a member;
 *   - an officer can allocate that exception later, drawing the suspense account down;
 *   - a replayed provider reference NEVER pays a member twice;
 *   - a part payment is recorded as part payment;
 *   - the Monnify webhook posts through the same engine.
 * The ledger must balance to zero after every one of these.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const suffix = Math.random().toString(36).slice(2, 8);
const slug = `recon-${suffix}`;
const ADMIN = { email: `recon-${suffix}@coopengine.test`, password: 'AdminPass123!' };

const SCHEME = 'Bearer';
const auth = (token: string) => ({ Authorization: `${SCHEME} ${token}` });

describe('payment reconciliation', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let token = '';
  let memberId = '';
  let memberNo = 0;

  const api = (path: string, method: 'get' | 'post' = 'post', body?: unknown) =>
    (body === undefined ? http[method](path) : http[method](path).send(body)).set(auth(token));

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
      .set(auth(saas.body.tokens.accessToken))
      .send({ name: `Recon ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    token = login.body.tokens.accessToken as string;

    const member = await api('/api/v1/members', 'post', {
      firstName: 'Ada',
      lastName: `Recon${suffix}`,
      phone: '08031234567',
    }).expect(201);
    memberId = member.body.id as string;
    memberNo = member.body.memberNo as number;
    await api(`/api/v1/members/${memberId}/approve`, 'post', {}).expect(200);
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const { rows } = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
      await client.query('COMMIT');
      const orgId = (rows[0] as { id: string } | undefined)?.id;
      if (orgId) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
        await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
        await client.query(`DELETE FROM org_lookups WHERE slug = $1`, [slug]);
        await client.query('COMMIT');
      }
    } finally {
      client.release();
    }
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  const trialBalanceZero = async () => {
    const res = await api('/api/v1/ledger/trial-balance', 'get').expect(200);
    const rows = (res.body.rows ?? res.body) as { debit?: string; credit?: string }[];
    const debit = rows.reduce((sum, r) => sum + Number(r.debit ?? 0), 0);
    const credit = rows.reduce((sum, r) => sum + Number(r.credit ?? 0), 0);
    expect(Math.round((debit - credit) * 100) / 100).toBe(0);
    return { debit, credit };
  };

  it('a transfer quoting an intent reference posts to that member and closes the intent', async () => {
    const intent = await api('/api/v1/payments/intents', 'post', {
      memberId,
      purpose: 'SAVINGS_DEPOSIT',
      expectedAmount: 25000,
      dueAt: new Date().toISOString().slice(0, 10),
    }).expect(201);
    const reference = intent.body.reference as string;

    const outcome = await api('/api/v1/payments/transactions', 'post', {
      provider: 'MANUAL',
      providerReference: `RCV-INTENT-${suffix}`,
      amount: 25000,
      payerName: 'ADA TRANSFER',
      narration: `TRANSFER ${reference} SAVINGS`,
    }).expect(201);

    expect(outcome.body.matched).toBe(true);
    expect(outcome.body.target).toBe('SAVINGS_DEPOSIT');

    const intents = await api('/api/v1/payments/intents?status=MATCHED', 'get').expect(200);
    expect(intents.body.map((i: { reference: string }) => i.reference)).toContain(reference);
    await trialBalanceZero();
  });

  it('a part payment is recorded as part payment, not as settled', async () => {
    const intent = await api('/api/v1/payments/intents', 'post', {
      memberId,
      purpose: 'SAVINGS_DEPOSIT',
      expectedAmount: 100000,
    }).expect(201);
    const reference = intent.body.reference as string;

    await api('/api/v1/payments/transactions', 'post', {
      provider: 'MANUAL',
      providerReference: `RCV-PART-${suffix}`,
      amount: 40000,
      narration: `PART PAYMENT ${reference}`,
    }).expect(201);

    const list = await api('/api/v1/payments/intents?status=PARTIAL', 'get').expect(200);
    const row = (list.body as { reference: string; received_amount: string }[]).find(
      (i) => i.reference === reference,
    );
    expect(row).toBeDefined();
    expect(Number(row?.received_amount)).toBe(40000);
  });

  it('a transfer nobody can be identified for becomes an exception, with the cash in suspense', async () => {
    const before = await api('/api/v1/payments/reconciliation', 'get').expect(200);
    const beforeUnallocated = Number(before.body.unallocatedBalance);

    const outcome = await api('/api/v1/payments/transactions', 'post', {
      provider: 'MANUAL',
      providerReference: `RCV-UNKNOWN-${suffix}`,
      amount: 15123.45,
      payerName: 'SOMEONE UNKNOWN',
      narration: 'TRANSFER NO REFERENCE',
    });
    expect(outcome.status, JSON.stringify(outcome.body)).toBe(201);

    expect(outcome.body.matched).toBe(false);
    expect(outcome.body.exception).toBe(true);

    const exceptions = await api('/api/v1/payments/exceptions', 'get').expect(200);
    const mine = (exceptions.body as { provider_reference: string }[]).find(
      (e) => e.provider_reference === `RCV-UNKNOWN-${suffix}`,
    );
    expect(mine).toBeDefined();

    const after = await api('/api/v1/payments/reconciliation', 'get').expect(200);
    expect(Number(after.body.unallocatedBalance)).toBe(
      Math.round((beforeUnallocated + 15123.45) * 100) / 100,
    );
    await trialBalanceZero();
  });

  it('an officer can allocate an exception, drawing the suspense account down', async () => {
    const exceptions = await api('/api/v1/payments/exceptions', 'get').expect(200);
    const mine = (
      exceptions.body as { id: string; provider_reference: string }[]
    ).find((e) => e.provider_reference === `RCV-UNKNOWN-${suffix}`);
    expect(mine).toBeDefined();

    const before = await api('/api/v1/payments/reconciliation', 'get').expect(200);
    const allocated = await api(`/api/v1/payments/exceptions/${mine?.id}/assign`, 'post', {
      memberId,
      purpose: 'SAVINGS_DEPOSIT',
    }).expect(200);
    expect(allocated.body.allocated).toBe(true);

    const after = await api('/api/v1/payments/reconciliation', 'get').expect(200);
    expect(Number(after.body.unallocatedBalance)).toBe(
      Math.round((Number(before.body.unallocatedBalance) - 15123.45) * 100) / 100,
    );

    const remaining = await api('/api/v1/payments/exceptions', 'get').expect(200);
    expect(
      (remaining.body as { provider_reference: string }[]).some(
        (e) => e.provider_reference === `RCV-UNKNOWN-${suffix}`,
      ),
    ).toBe(false);
    await trialBalanceZero();
  });

  it('a replayed provider reference never pays a member twice', async () => {
    const intent = await api('/api/v1/payments/intents', 'post', {
      memberId,
      purpose: 'SAVINGS_DEPOSIT',
      expectedAmount: 7500,
    }).expect(201);
    const reference = `RCV-REPLAY-${suffix}`;
    const first = await api('/api/v1/payments/transactions', 'post', {
      provider: 'MONNIFY',
      providerReference: reference,
      amount: 7500,
      narration: `TRANSFER ${intent.body.reference}`,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.matched).toBe(true);

    const balanceAfterFirst = await savingsTotal();

    const second = await api('/api/v1/payments/transactions', 'post', {
      provider: 'MONNIFY',
      providerReference: reference,
      amount: 7500,
      narration: `TRANSFER ${intent.body.reference}`,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.note).toMatch(/already recorded/i);

    expect(await savingsTotal()).toBe(balanceAfterFirst);
    await trialBalanceZero();
  });

  it('the Monnify webhook posts through the same engine', async () => {
    const account = await api('/api/v1/payments/virtual-accounts', 'post', {
      memberId,
    }).expect(201);
    const accountNumber = account.body.accountNumber as string;
    expect(accountNumber).toBeTruthy();

    const payload = {
      accountNumber,
      paymentReference: `MON-${suffix}`,
      transactionReference: `MON-TX-${suffix}`,
      amountPaid: 5000,
      transactionStatus: 'SUCCESSFUL',
      payerName: 'WEBHOOK PAYER',
      paymentDescription: 'contribution',
      paymentDate: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const secret = process.env.MONNIFY_SECRET_KEY ?? 'monnify-dev-secret';
    const signature = createHash('sha512').update(`${secret}|${raw}`).digest('hex');

    const res = await http
      .post('/api/v1/payments/monnify/webhook')
      .set('content-type', 'application/json')
      .set('monnify-signature', signature)
      .send(raw);
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.acknowledged, JSON.stringify(res.body)).toBe(true);
    expect(res.body.matched, JSON.stringify(res.body)).toBe(true);
    await trialBalanceZero();
  });

  /** The member's savings total, from the same figure the portal shows. */
  async function savingsTotal(): Promise<number> {
    const res = await api(`/api/v1/reports/member/${memberId}/360`, 'get').expect(200);
    return Number((res.body as { savingsTotal?: string }).savingsTotal ?? 0);
  }
});
