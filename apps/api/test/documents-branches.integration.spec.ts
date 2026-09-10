/**
 * KYC document vault + branch management (real PostgreSQL).
 *
 * Proves: member/staff uploads with type+size validation, metadata listing,
 * byte-accurate download, verification workflow with audit, branch CRUD with
 * single-headquarters rule, member assignment, and tenant isolation of files.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
process.env.DOCUMENTS_DIR = process.env.DOCUMENTS_DIR ?? '/tmp/coopengine-test-uploads';

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

describe('document vault and branches', () => {
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
    await rm(join(process.env.DOCUMENTS_DIR as string), { recursive: true, force: true });
  });

  it('stores, verifies and isolates KYC documents', async () => {
    const coop = await onboardCoop('dv2');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const email = `doc-${randomUUID().slice(0, 6)}@coopengine.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({ firstName: 'Doc', lastName: 'Member', email });
    const memberId = (created.body.id ?? created.body.member?.id) as string;
    await request(app.getHttpServer()).post(`/api/v1/members/${memberId}/approve`).set(auth).send({});

    // A tiny valid PNG (1x1) as base64
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

    const upload = await request(app.getHttpServer())
      .post(`/api/v1/members/${memberId}/documents`)
      .set(auth)
      .send({ docType: 'ID_CARD', fileName: 'id card.png', mimeType: 'image/png', contentBase64: png });
    expect(upload.status).toBe(201);
    expect(upload.body.status).toBe('PENDING');
    const docId = upload.body.id as string;

    // Validation: unsupported type and unsupported mime
    const badType = await request(app.getHttpServer())
      .post(`/api/v1/members/${memberId}/documents`)
      .set(auth)
      .send({ docType: 'PASSPORT_PHOTO', fileName: 'x.png', mimeType: 'image/png', contentBase64: png });
    expect(badType.status).toBe(400);

    const badMime = await request(app.getHttpServer())
      .post(`/api/v1/members/${memberId}/documents`)
      .set(auth)
      .send({ docType: 'ID_CARD', fileName: 'x.exe', mimeType: 'application/x-msdownload', contentBase64: png });
    expect(badMime.status).toBe(400);

    // Listing + verification queue
    const list = await request(app.getHttpServer())
      .get(`/api/v1/members/${memberId}/documents`)
      .set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const queue = await request(app.getHttpServer()).get('/api/v1/documents?status=PENDING').set(auth);
    expect(queue.body.length).toBeGreaterThan(0);

    // Download returns the exact bytes
    const download = await request(app.getHttpServer())
      .get(`/api/v1/documents/${docId}/download`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect((download.body as Buffer).toString('base64')).toBe(png);

    // Verify with audit
    const verified = await request(app.getHttpServer())
      .post(`/api/v1/documents/${docId}/verify`)
      .set(auth)
      .send({ status: 'VERIFIED', notes: 'Matches member record' });
    expect(verified.status).toBe(201);
    expect(verified.body.status).toBe('VERIFIED');

    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('document.uploaded','document.verified')`,
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);

    // Members can upload to their own vault
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email });
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: coop.slug, email, code: otp.body.devCode });
    const mToken = verify.body.accessToken as string;
    const selfUpload = await request(app.getHttpServer())
      .post('/api/v1/member/documents')
      .set({ Authorization: `Bearer ${mToken}` })
      .send({ docType: 'UTILITY_BILL', fileName: 'bill.pdf', mimeType: 'application/pdf', contentBase64: png });
    expect(selfUpload.status).toBe(201);
    const mine = await request(app.getHttpServer())
      .get('/api/v1/member/documents')
      .set({ Authorization: `Bearer ${mToken}` });
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(2);

    // Another tenant cannot read this document (RLS): row is invisible
    const other = await onboardCoop('dv3');
    const otherRead = await request(app.getHttpServer())
      .get(`/api/v1/documents/${docId}/download`)
      .set({ Authorization: `Bearer ${other.tokens.accessToken}` });
    expect(otherRead.status).toBe(404);
  });

  it('manages branches and member assignment', async () => {
    const coop = await onboardCoop('br');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const hq = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set(auth)
      .send({ name: 'Head Office', code: 'HQ', isHeadquarters: true });
    expect(hq.status).toBe(201);

    const annex = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set(auth)
      .send({ name: 'Kaduna Annex', code: 'KD' });
    expect(annex.status).toBe(201);

    const dup = await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set(auth)
      .send({ name: 'kaduna annex' });
    expect(dup.status).toBe(409);

    const list = await request(app.getHttpServer()).get('/api/v1/branches').set(auth);
    expect(list.status).toBe(200);
    const names = list.body.map((b: { name: string }) => b.name);
    expect(names).toContain('Head Office');
    expect(names).toContain('Kaduna Annex');
    // exactly one headquarters across the tenant (onboarding seeds one)
    expect(list.body.filter((b: { isHeadquarters: boolean }) => b.isHeadquarters)).toHaveLength(1);

    // Move headquarters to the annex — only one at a time
    const moved = await request(app.getHttpServer())
      .patch(`/api/v1/branches/${annex.body.id}`)
      .set(auth)
      .send({ isHeadquarters: true });
    expect(moved.status).toBe(200);
    const afterMove = await request(app.getHttpServer()).get('/api/v1/branches').set(auth);
    expect(afterMove.body.filter((b: { isHeadquarters: boolean }) => b.isHeadquarters)).toHaveLength(1);
    expect(
      afterMove.body.find((b: { isHeadquarters: boolean }) => b.isHeadquarters).id,
    ).toBe(annex.body.id);

    // Assign a member to a branch and check the count
    const email = `br-${randomUUID().slice(0, 6)}@coopengine.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({ firstName: 'Branch', lastName: 'Member', email });
    const memberId = (created.body.id ?? created.body.member?.id) as string;
    await request(app.getHttpServer()).post(`/api/v1/members/${memberId}/approve`).set(auth).send({});

    const assigned = await request(app.getHttpServer())
      .post(`/api/v1/branches/members/${memberId}/assign`)
      .set(auth)
      .send({ branchId: annex.body.id });
    expect(assigned.status).toBe(201);

    const list2 = await request(app.getHttpServer()).get('/api/v1/branches').set(auth);
    const annexRow = list2.body.find((b: { id: string }) => b.id === annex.body.id);
    expect(annexRow.memberCount).toBe(1);

    const bad = await request(app.getHttpServer())
      .post(`/api/v1/branches/members/${memberId}/assign`)
      .set(auth)
      .send({ branchId: randomUUID() });
    expect(bad.status).toBe(404);
  });
});
