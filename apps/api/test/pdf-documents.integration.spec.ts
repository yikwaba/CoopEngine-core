/**
 * Printable documents (real PostgreSQL + real PDFs).
 *
 * Proves the documents a cooperative actually hands out are generated server-side:
 * member savings statement, loan statement, board pack and a counter receipt.
 * Each must be a genuine PDF (magic bytes, page objects, sensible size) with a
 * filename, and must not leak across tenants.
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
import { money } from '../src/pdf/pdf.service';

const ADMIN_EMAIL = 'admin@coopengine.dev';
let app: INestApplication;
let pool: Pool;

/** A PDF is real when it has the magic header, page objects, and an EOF marker. */
function assertPdf(res: request.Response, label: string, minSize = 2500): void {
  const body = res.body as Buffer;
  expect(res.status, `${label} status`).toBe(200);
  expect(res.headers['content-type'], `${label} content-type`).toContain('application/pdf');
  expect(res.headers['content-disposition'], `${label} filename`).toMatch(/filename=".+\.pdf"/);
  expect(body.subarray(0, 5).toString(), `${label} magic bytes`).toBe('%PDF-');
  expect(body.length, `${label} size`).toBeGreaterThan(minSize);
  expect(body.toString('latin1'), `${label} page objects`).toMatch(/\/Type\s*\/Page/);
  expect(body.toString('latin1').trimEnd().endsWith('%%EOF'), `${label} EOF marker`).toBe(true);
}

describe('printable documents', () => {
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

  it('renders statements, a board pack and a receipt', async () => {
    const saas = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const suffix = randomUUID().slice(0, 8);
    await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saas.body.tokens.accessToken}`)
      .send({
        name: 'Printers Cooperative',
        slug: `print-${suffix}`,
        adminEmail: `print-${suffix}@coopengine.test`,
        adminPassword: 'CoopPass123!',
      });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `print-${suffix}@coopengine.test`, password: 'CoopPass123!' });
    const token = login.body.tokens.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      org?: string;
      organizationId?: string;
    };
    const orgId = (claims.org ?? claims.organizationId) as string;
    expect(orgId, 'the token carries the tenant id').toBeTruthy();

    // a member with real activity
    const email = `print-member-${suffix}@coopengine.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({ firstName: 'Paper', lastName: 'Trail', email, phone: '+2348030000000' });
    const memberId = (created.body.id ?? created.body.member?.id) as string;
    await request(app.getHttpServer()).post(`/api/v1/members/${memberId}/approve`).set(auth).send({});
    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set(auth)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;
    for (const amount of [50000, 25000, 15000]) {
      await request(app.getHttpServer())
        .post(`/api/v1/savings/accounts/${accountId}/deposits`)
        .set(auth)
        .send({ amount, description: `deposit ${amount}` });
    }
    // cooperative loans need two ACTIVE guarantors (the Sprint 25 gate)
    const guarantors: string[] = [];
    for (const n of [1, 2]) {
      const g = await request(app.getHttpServer())
        .post('/api/v1/members')
        .set(auth)
        .send({
          firstName: `Guarantor${n}`,
          lastName: 'Paper',
          email: `print-g${n}-${suffix}@coopengine.test`,
          phone: `+23480300000${n}0`,
        });
      const gid = (g.body.id ?? g.body.member?.id) as string;
      await request(app.getHttpServer()).post(`/api/v1/members/${gid}/approve`).set(auth).send({});
      guarantors.push(gid);
    }

    // a loan must reference one of the tenant's products
    const productsRes = await request(app.getHttpServer()).get('/api/v1/products/loans').set(auth);
    const productList = (productsRes.body.items ?? productsRes.body) as { id: string }[];
    expect(productList.length).toBeGreaterThan(0);
    const productId = productList[0].id;

    const loan = await request(app.getHttpServer())
      .post('/api/v1/loans')
      .set(auth)
      .send({ memberId, productId, principal: 40000, termMonths: 6, guarantorIds: guarantors });
    expect([200, 201], `loan create: ${JSON.stringify(loan.body).slice(0, 160)}`).toContain(loan.status);
    const loanId = (loan.body.id ?? loan.body.loanId) as string;
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/approve`).set(auth).send({});
    await request(app.getHttpServer()).post(`/api/v1/loans/${loanId}/disburse`).set(auth).send({});

    // ---- member savings statement ---------------------------------------
    const statement = await request(app.getHttpServer())
      .get(`/api/v1/pdf/members/${memberId}/statement.pdf`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assertPdf(statement, 'member statement');

    // a narrower period still produces a valid document
    const ranged = await request(app.getHttpServer())
      .get(`/api/v1/pdf/members/${memberId}/statement.pdf?from=2026-01-01&to=2026-12-31`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assertPdf(ranged, 'ranged statement');

    // ---- loan statement ---------------------------------------------------
    const loanPdf = await request(app.getHttpServer())
      .get(`/api/v1/pdf/loans/${loanId}/statement.pdf`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assertPdf(loanPdf, 'loan statement');

    // ---- board pack -------------------------------------------------------
    const period = new Date().toISOString().slice(0, 7);
    const board = await request(app.getHttpServer())
      .get(`/api/v1/pdf/board-pack.pdf?period=${period}`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assertPdf(board, 'board pack');
    expect(board.headers['content-disposition']).toContain('board-pack-');

    // ---- counter receipt --------------------------------------------------
    const client = await pool.connect();
    let transactionId = '';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const rows = await client.query(
        `SELECT id FROM savings_transactions ORDER BY created_at DESC LIMIT 1`,
      );
      transactionId = (rows.rows[0] as { id: string } | undefined)?.id ?? '';
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(transactionId, 'a savings transaction to print a receipt for').toBeTruthy();

    const receipt = await request(app.getHttpServer())
      .get(`/api/v1/pdf/receipts/${transactionId}.pdf`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    // a receipt is a single small page, so it is held to its own floor
    assertPdf(receipt, 'receipt', 1500);

    // ---- isolation and not-found -----------------------------------------
    const unknown = await request(app.getHttpServer())
      .get(`/api/v1/pdf/members/${randomUUID()}/statement.pdf`)
      .set(auth);
    expect(unknown.status).toBe(404);

    // another tenant cannot print this member's statement
    const other = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saas.body.tokens.accessToken}`)
      .send({
        name: 'Other Printers',
        slug: `print-other-${suffix}`,
        adminEmail: `print-other-${suffix}@coopengine.test`,
        adminPassword: 'CoopPass123!',
      });
    expect([200, 201]).toContain(other.status);
    const otherLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `print-other-${suffix}@coopengine.test`, password: 'CoopPass123!' });
    const foreign = await request(app.getHttpServer())
      .get(`/api/v1/pdf/members/${memberId}/statement.pdf`)
      .set({ Authorization: `Bearer ${otherLogin.body.tokens.accessToken}` });
    expect(foreign.status).toBe(404);
  });

  it('formats money the way a treasurer expects', () => {
    expect(money(1234567.5)).toBe('₦1,234,567.50');
    expect(money('0')).toBe('₦0.00');
    expect(money(-2500)).toBe('-₦2,500.00');
    expect(money(null)).toBe('₦0.00');
    expect(money(Number.NaN)).toBe('₦0.00');
  });
});
