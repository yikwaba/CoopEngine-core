/**
 * Membership module integration tests (real PostgreSQL).
 *
 * Covers the member lifecycle (FR-006): create -> approve/activate ->
 * suspend -> reactivate -> exit, per-org sequential member_no (FR-006/007),
 * and cross-tenant member isolation at the API level.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ensureRbacSeeded } from './helpers';

const ADMIN_EMAIL = 'admin@coopengine.dev';
const ADMIN_PASSWORD = 'AdminDev123!';

let app: INestApplication;
let pool: Pool;

interface CoopContext {
  orgId: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
  tokens: { accessToken: string };
}

/** Onboard a cooperative via the API and log in as its admin. */
async function onboardCoop(label: string): Promise<CoopContext> {
  const saasLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(saasLogin.status).toBe(200);
  const saasToken = saasLogin.body.tokens.accessToken as string;

  const suffix = randomUUID().slice(0, 8);
  const slug = `${label}-${suffix}`;
  const adminEmail = `${label}-${suffix}@coopengine.test`;
  const adminPassword = 'CoopPass123!';

  const onboard = await request(app.getHttpServer())
    .post('/api/v1/organizations')
    .set('Authorization', `Bearer ${saasToken}`)
    .send({ name: `${label} cooperative`, slug, adminEmail, adminPassword });
  expect(onboard.status).toBe(201);

  const coopLogin = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: adminEmail, password: adminPassword });
  expect(coopLogin.status).toBe(200);

  return {
    orgId: onboard.body.id as string,
    slug,
    adminEmail,
    adminPassword,
    tokens: { accessToken: coopLogin.body.tokens.accessToken as string },
  };
}

function memberPayload(seed: string) {
  return {
    firstName: `First${seed}`,
    lastName: `Last${seed}`,
    email: `member-${seed.toLowerCase()}@coopengine.test`,
    phone: '+2348012345678',
    gender: 'MALE',
  };
}

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

describe('membership lifecycle', () => {
  it('creates members with sequential per-org member numbers', async () => {
    const coop = await onboardCoop('life');
    const { tokens } = coop;

    const first = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send(memberPayload('A'));
    expect(first.status).toBe(201);
    expect(first.body.memberNo).toBe(1);
    expect(first.body.status).toBe('PENDING');
    const firstId = first.body.id as string;

    const second = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send(memberPayload('B'));
    expect(second.status).toBe(201);
    expect(second.body.memberNo).toBe(2);

    const list = await request(app.getHttpServer())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((m: { memberNo: number }) => m.memberNo)).toEqual([1, 2]);

    // Validation: bad email rejected
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ firstName: 'X', lastName: 'Y', email: 'not-an-email' });
    expect(invalid.status).toBe(400);

    // Approve -> ACTIVE with joined_at
    const approved = await request(app.getHttpServer())
      .post(`/api/v1/members/${firstId}/approve`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('ACTIVE');
    expect(approved.body.joinedAt).toBeTruthy();

    // Duplicate approve -> conflict (ACTIVE -> ACTIVE invalid)
    const reApprove = await request(app.getHttpServer())
      .post(`/api/v1/members/${firstId}/approve`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(reApprove.status).toBe(409);

    // Suspend then reactivate
    const suspended = await request(app.getHttpServer())
      .post(`/api/v1/members/${firstId}/suspend`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    const reactivated = await request(app.getHttpServer())
      .post(`/api/v1/members/${firstId}/reactivate`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe('ACTIVE');

    // Exit terminal state
    const exited = await request(app.getHttpServer())
      .post(`/api/v1/members/${firstId}/exit`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(exited.status).toBe(200);
    expect(exited.body.member.status).toBe('EXITED');

    // No further transitions from EXITED
    const afterExit = await request(app.getHttpServer())
      .post(`/api/v1/members/${firstId}/reactivate`)
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(afterExit.status).toBe(409);

    // Unauthenticated create -> 401
    const unauth = await request(app.getHttpServer())
      .post('/api/v1/members')
      .send(memberPayload('C'));
    expect(unauth.status).toBe(401);
  });

  it('isolates member data between cooperatives (cross-tenant 404)', async () => {
    const coopA = await onboardCoop('iso-a');
    const coopB = await onboardCoop('iso-b');

    const createB = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set('Authorization', `Bearer ${coopB.tokens.accessToken}`)
      .send(memberPayload('BOnly'));
    expect(createB.status).toBe(201);
    const memberBId = createB.body.id as string;
    expect(createB.body.memberNo).toBe(1); // each coop numbers from 1

    // Coop A cannot read coop B's member by id
    const crossRead = await request(app.getHttpServer())
      .get(`/api/v1/members/${memberBId}`)
      .set('Authorization', `Bearer ${coopA.tokens.accessToken}`);
    expect(crossRead.status).toBe(404);

    // Coop A member list contains none of coop B's members
    const listA = await request(app.getHttpServer())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${coopA.tokens.accessToken}`);
    expect(listA.status).toBe(200);
    expect(listA.body).toHaveLength(0);

    // Coop A cannot transition coop B's member
    const crossTransition = await request(app.getHttpServer())
      .post(`/api/v1/members/${memberBId}/approve`)
      .set('Authorization', `Bearer ${coopA.tokens.accessToken}`);
    expect(crossTransition.status).toBe(404);
  });
});


describe('member CSV import (preview + commit)', () => {
  const CSV_HEADER = 'firstName,lastName,email,phone,gender,dateOfBirth';

  it('previews control totals, flags invalid rows, and commits only valid ones', async () => {
    const coop = await onboardCoop('imp');
    const { tokens } = coop;

    // Pre-create a member whose email will collide with the CSV
    const existing = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ ...memberPayload('Existing'), email: 'collision@coopengine.test' });
    expect(existing.status).toBe(201);

    const csv = [
      CSV_HEADER,
      'Ada,Lovelace,ada@coopengine.test,+2348011111111,FEMALE,1985-01-01',
      'Grace,Hopper,grace@coopengine.test,,FEMALE,',
      ',OnlyLastName,,+2348033333333,,',
      'Bad,Email,bad-email,,,',
      'Ada,Lovelace2,ada@coopengine.test,,,',
      'Collides,Email,COLLISION@coopengine.test,,,',
    ].join('\n');

    const preview = await request(app.getHttpServer())
      .post('/api/v1/members/import/preview')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ filename: 'members.csv', csv });
    expect(preview.status).toBe(201);
    const body = preview.body as {
      batchId: string;
      totals: { totalRows: number; valid: number; invalid: number };
      errors: { row: number; reasons: string[] }[];
    };
    expect(body.totals).toEqual({ totalRows: 6, valid: 2, invalid: 4 });
    expect(body.errors).toHaveLength(4);
    expect(body.errors.some((e) => e.reasons.includes('firstName is required'))).toBe(true);
    expect(
      body.errors.some((e) =>
        e.reasons.some((r) => r.startsWith('duplicate email in file')),
      ),
    ).toBe(true);
    expect(
      body.errors.some((e) =>
        e.reasons.includes('email is already a member of this cooperative'),
      ),
    ).toBe(true);

    // Commit: only the 2 valid rows become members (member_no 1 and 2)
    const commit = await request(app.getHttpServer())
      .post('/api/v1/members/import/commit')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ batchId: body.batchId });
    expect(commit.status).toBe(201);
    expect(commit.body.committed).toBe(2);
    // member 1 was the pre-created collision member; imports continue from 2
    expect(commit.body.memberNumbers).toEqual([2, 3]);

    const list = await request(app.getHttpServer())
      .get('/api/v1/members')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3); // 1 pre-created + 2 imported
    const imported = (list.body as { email: string | null }[]).filter(
      (m) => m.email === 'ada@coopengine.test' || m.email === 'grace@coopengine.test',
    );
    expect(imported).toHaveLength(2);

    // Re-committing the same batch -> 409
    const reCommit = await request(app.getHttpServer())
      .post('/api/v1/members/import/commit')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ batchId: body.batchId });
    expect(reCommit.status).toBe(409);

    // Preview of a nonexistent org's batch (cross-tenant) -> 404 on commit
    const otherCoop = await onboardCoop('imp-b');
    const crossCommit = await request(app.getHttpServer())
      .post('/api/v1/members/import/commit')
      .set('Authorization', `Bearer ${otherCoop.tokens.accessToken}`)
      .send({ batchId: body.batchId });
    expect(crossCommit.status).toBe(404);
  });

  it('rejects malformed CSV and unauthenticated previews', async () => {
    const coop = await onboardCoop('imp-c');
    const { tokens } = coop;

    // Missing required column
    const noHeader = await request(app.getHttpServer())
      .post('/api/v1/members/import/preview')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ filename: 'bad.csv', csv: 'firstName,lastName\nAda,Lovelace' });
    expect(noHeader.status).toBe(400);

    // Empty body
    const empty = await request(app.getHttpServer())
      .post('/api/v1/members/import/preview')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .send({ filename: 'empty.csv', csv: '' });
    expect(empty.status).toBe(400);

    // Unauthenticated
    const unauth = await request(app.getHttpServer())
      .post('/api/v1/members/import/preview')
      .send({ filename: 'x.csv', csv: CSV_HEADER + '\nAda,Lovelace' });
    expect(unauth.status).toBe(401);
  });
});
