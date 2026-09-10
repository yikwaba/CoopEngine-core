/**
 * Savings goals + standing contributions + CSV dry-run (real PostgreSQL).
 *
 * Proves: member-created goals with live progress that flip to ACHIEVED with a
 * notification, monthly/weekly instructions whose nightly sweep queues a
 * contribution reminder and advances the next run date, and that the member
 * CSV import preview is a true dry-run (reports row errors, inserts nothing).
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
process.env.INTERNAL_CRON_TOKEN = process.env.INTERNAL_CRON_TOKEN ?? 'test-internal-token';

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

describe('savings goals, contributions and CSV dry-run', () => {
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

  it('tracks goal progress, achieves it, and sweeps contribution reminders', async () => {
    const coop = await onboardCoop('gl');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const email = `gl-${randomUUID().slice(0, 6)}@coopengine.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/members')
      .set(auth)
      .send({ firstName: 'Goal', lastName: 'Saver', email, phone: '+2348011111111' });
    const memberId = (created.body.id ?? created.body.member?.id) as string;
    await request(app.getHttpServer()).post(`/api/v1/members/${memberId}/approve`).set(auth).send({});

    const acct = await request(app.getHttpServer())
      .post(`/api/v1/savings/member/${memberId}/account`)
      .set(auth)
      .send({});
    const accountId = (acct.body.id ?? acct.body.account?.id) as string;

    // Member session
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/member/request-otp')
      .send({ organizationSlug: coop.slug, email });
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/member/verify-otp')
      .send({ organizationSlug: coop.slug, email, code: otp.body.devCode });
    const mAuth = { Authorization: `Bearer ${verify.body.accessToken as string}` };

    // Member files a goal (starting balance snapshotted at 0)
    const goal = await request(app.getHttpServer())
      .post('/api/v1/member/goals')
      .set(mAuth)
      .send({ name: 'School fees', targetAmount: 50000, targetDate: '2026-12-31' });
    expect([200, 201], JSON.stringify(goal.body)).toContain(goal.status);

    // Partial deposit → 40% progress
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 20000, idempotencyKey: randomUUID() });
    let mine = await request(app.getHttpServer()).get('/api/v1/member/goals').set(mAuth);
    expect(mine.body[0].progress).toBe(20000);
    expect(mine.body[0].percent).toBe(40);
    expect(mine.body[0].status).toBe('ACTIVE');

    // Complete the goal → ACHIEVED + notification
    await request(app.getHttpServer())
      .post(`/api/v1/savings/accounts/${accountId}/deposits`)
      .set(auth)
      .send({ amount: 30000, idempotencyKey: randomUUID() });
    mine = await request(app.getHttpServer()).get('/api/v1/member/goals').set(mAuth);
    expect(mine.body[0].progress).toBe(50000);
    expect(mine.body[0].status).toBe('ACHIEVED');
    expect(mine.body[0].percent).toBe(100);

    const goalNotes = await request(app.getHttpServer())
      .get('/api/v1/notifications?type=SAVINGS_GOAL_ACHIEVED')
      .set(auth);
    expect(goalNotes.body.items).toHaveLength(1);

    // Standing instruction: monthly, immediately due
    const instruction = await request(app.getHttpServer())
      .post('/api/v1/member/standing-instructions')
      .set(mAuth)
      .send({ amount: 5000, frequency: 'MONTHLY' });
    expect([200, 201]).toContain(instruction.status);
    const instructionId = instruction.body.id as string;

    const mineInstr = await request(app.getHttpServer())
      .get('/api/v1/member/standing-instructions')
      .set(mAuth);
    expect(mineInstr.body).toHaveLength(1);
    expect(mineInstr.body[0].nextRunDate).toBeTruthy();

    // Force it due today via the staff API, then run the sweep
    const today = new Date().toISOString().slice(0, 10);
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/savings/standing-instructions/${instructionId}`)
      .set(auth)
      .send({ nextRunDate: today });
    expect(updated.status).toBe(200);
    const before = updated.body.nextRunDate;

    const sweep = await request(app.getHttpServer())
      .post('/api/v1/internal/savings/sweep')
      .set('x-internal-token', process.env.INTERNAL_CRON_TOKEN as string)
      .send({});
    expect(sweep.status).toBe(201);
    expect(sweep.body.reminded).toBeGreaterThanOrEqual(1);

    const dueNotes = await request(app.getHttpServer())
      .get('/api/v1/notifications?type=CONTRIBUTION_DUE')
      .set(auth);
    expect(dueNotes.body.items.length).toBeGreaterThanOrEqual(1);

    const after = await request(app.getHttpServer())
      .get('/api/v1/member/standing-instructions')
      .set(mAuth);
    expect(after.body[0].nextRunDate).not.toBe(before);

    // Unauthorised internal sweep is rejected
    const bad = await request(app.getHttpServer())
      .post('/api/v1/internal/savings/sweep')
      .set('x-internal-token', 'wrong')
      .send({});
    expect(bad.status).toBe(401);
  });

  it('validates a member CSV as a dry-run without inserting anything', async () => {
    const coop = await onboardCoop('cs');
    const auth = { Authorization: `Bearer ${coop.tokens.accessToken}` };

    const before = await request(app.getHttpServer())
      .get('/api/v1/members?limit=1')
      .set(auth);
    const countBefore = Number(before.headers['x-total-count'] ?? 0);

    const csv = [
      'firstName,lastName,email,phone,gender,dateOfBirth',
      `Ada,Nwosu,ada-${randomUUID().slice(0, 6)}@coopengine.test,+2348022222222,FEMALE,1990-04-12`,
      `,MissingFirst,bad-${randomUUID().slice(0, 6)},not-a-phone,,`,
    ].join('\n');

    const preview = await request(app.getHttpServer())
      .post('/api/v1/members/import/preview')
      .set(auth)
      .send({ filename: 'members.csv', csv });
    expect(preview.status).toBe(201);
    expect(preview.body.totals.totalRows).toBe(2);
    expect(preview.body.totals.valid).toBe(1);
    expect(preview.body.totals.invalid).toBe(1);
    expect(preview.body.errors).toHaveLength(1);
    expect(preview.body.sampleValid).toHaveLength(1);

    const after = await request(app.getHttpServer()).get('/api/v1/members?limit=1').set(auth);
    const countAfter = Number(after.headers['x-total-count'] ?? 0);
    expect(countAfter).toBe(countBefore);
  });
});
