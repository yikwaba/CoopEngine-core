/**
 * Report CSV export integration tests (real PostgreSQL).
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

beforeAll(async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://coopengine:coopengine@127.0.0.1:5432/coopengine';
  pool = createPool(process.env.DATABASE_URL);
  await ensureRbacSeeded(pool);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

describe('report CSV exports', () => {
  it('downloads savings-book, loan-book, contribution and audit CSVs', async () => {
    // Onboard + one member funded via savings so exports have content
    const saasLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const suffix = randomUUID().slice(0, 8);
    const onboard = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${saasLogin.body.tokens.accessToken}`)
      .send({
        name: `Export cooperative`,
        slug: `exp-${suffix}`,
        adminEmail: `exp-${suffix}@coopengine.test`,
        adminPassword: 'CoopPass123!',
      });
    expect(onboard.status).toBe(201);
    const coopLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `exp-${suffix}@coopengine.test`, password: 'CoopPass123!' });
    const auth = { Authorization: `Bearer ${coopLogin.body.tokens.accessToken}` };

    const member = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({ firstName: 'Export', lastName: 'Row', email: `exp-${suffix}-m@coopengine.test` });
    await request(app.getHttpServer()).post(`/api/v1/members/${member.body.id}/approve`).set(auth);
    const acc = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${member.body.id}/account`)
      .set(auth)
      .send({});
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${acc.body.id}/deposits`)
      .set(auth)
      .send({ amount: 12500 });

    const savings = await request(app.getHttpServer())
      .get('/api/v1/reports/export/savings-book')
      .set(auth);
    expect(savings.status).toBe(200);
    expect(savings.headers['content-type']).toContain('text/csv');
    expect(savings.headers['content-disposition']).toContain('savings-book');
    const lines = (savings.text as string).trim().split('\n');
    expect(lines[0]).toBe('memberNo,memberName,accountNo,productCode,balance,status');
    expect(lines[1]).toContain('12500.00');

    const audit = await request(app.getHttpServer())
      .get('/api/v1/reports/export/audit-logs')
      .set(auth);
    expect(audit.status).toBe(200);
    expect(audit.headers['content-type']).toContain('text/csv');
    expect((audit.text as string).split('\n')[0]).toBe('createdAt,actor,action,entityType,entityId,metadata');

    const contributions = await request(app.getHttpServer())
      .get('/api/v1/reports/export/contribution-schedule')
      .set(auth);
    expect(contributions.status).toBe(200);
    expect((contributions.text as string).split('\n')[1]).toContain('12500.00');

    const loans = await request(app.getHttpServer())
      .get('/api/v1/reports/export/loan-book')
      .set(auth);
    expect(loans.status).toBe(200);
    expect((loans.text as string).split('\n')[0]).toContain('memberNo');

    const bad = await request(app.getHttpServer())
      .get('/api/v1/reports/export/nope')
      .set(auth);
    expect(bad.status).toBe(400);
  });
});
