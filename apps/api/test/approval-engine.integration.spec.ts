/**
 * FR-020 approval engine — vertical slices against real PostgreSQL.
 *
 * This first slice deliberately starts at the HTTP boundary. It proves an amount
 * selects exactly one active policy and snapshots the ordered chain into a request.
 * Later slices add decisions, refusal paths, delegation and money-path wiring.
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

const suffix = randomUUID().slice(0, 8);
const slug = `engine-${suffix}`;
const adminEmail = `engine-${suffix}@coopengine.test`;
const password = 'CoopPass123!';
const auth = (token: string) => ({ Authorization: ['Bearer', token].join(' ') });

let app: INestApplication;
let pool: Pool;
let orgId = '';
let requesterId = '';
let token = '';
let treasurerToken = '';
let treasurerUserId = '';
let chairmanToken = '';
let chairmanUserId = '';
let creditCommitteeToken = '';
let lowerRequestId = '';

describe('FR-020 approval engine', () => {
  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const http = request(app.getHttpServer());
    const saas = await http
      .post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD })
      .expect(200);
    await http
      .post('/api/v1/organizations')
      .set(auth(saas.body.tokens.accessToken))
      .send({ name: `Approval Engine ${suffix}`, slug, adminEmail, adminPassword: password })
      .expect(201);

    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password, organizationSlug: slug })
      .expect(200);
    token = login.body.tokens.accessToken as string;
    requesterId = login.body.user.id as string;

    const inviteAndLogin = async (roleCode: string, label: string) => {
      const email = `${label}-${suffix}@coopengine.test`;
      const invited = await http
        .post('/api/v1/users')
        .set(auth(token))
        .send({ email, roleCodes: [roleCode] })
        .expect(201);
      const signedIn = await http
        .post('/api/v1/auth/login')
        .send({ email, password: invited.body.tempPassword, organizationSlug: slug })
        .expect(200);
      return {
        token: signedIn.body.tokens.accessToken as string,
        userId: signedIn.body.user.id as string,
      };
    };
    const treasurer = await inviteAndLogin('TREASURER', 'treasurer');
    treasurerToken = treasurer.token;
    treasurerUserId = treasurer.userId;
    const chairman = await inviteAndLogin('CHAIRMAN', 'chairman');
    chairmanToken = chairman.token;
    chairmanUserId = chairman.userId;
    creditCommitteeToken = (await inviteAndLogin('CREDIT_COMMITTEE', 'credit')).token;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
      const org = await client.query<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
      orgId = org.rows[0].id;
      await client.query(`SELECT set_config('app.internal_scan', 'off', true)`);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const policy = await client.query<{ id: string }>(
        `INSERT INTO approval_policies
           (organization_id, kind, min_amount, max_amount, version, description, created_by)
         VALUES ($1, 'WITHDRAWAL', 0, 500000, 1,
                 'Up to and including NGN 500,000', $2)
         RETURNING id`,
        [orgId, requesterId],
      );
      await client.query(
        `INSERT INTO approval_policy_steps
           (organization_id, policy_id, step_no, approver_role_code, label)
         VALUES ($1, $2, 1, 'TREASURER', 'Treasurer'),
                ($1, $2, 2, 'CHAIRMAN', 'Chairman')`,
        [orgId, policy.rows[0].id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (orgId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
        await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
        await client.query(`DELETE FROM org_lookups WHERE slug = $1`, [slug]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.end();
    await app.close();
  });

  it('allows the two PRD amount bands to share policy version 1', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const policy = await client.query<{ id: string }>(
        `INSERT INTO approval_policies
           (organization_id, kind, min_amount, max_amount, version, description, created_by)
         VALUES ($1, 'WITHDRAWAL', 500001, 2000000, 1,
                 'NGN 500,001 through NGN 2,000,000', $2)
         RETURNING id`,
        [orgId, requesterId],
      );
      await client.query(
        `INSERT INTO approval_policy_steps
           (organization_id, policy_id, step_no, approver_role_code, label)
         VALUES ($1, $2, 1, 'TREASURER', 'Treasurer'),
                ($1, $2, 2, 'CREDIT_COMMITTEE', 'Credit Committee'),
                ($1, $2, 3, 'CHAIRMAN', 'Chairman')`,
        [orgId, policy.rows[0]!.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('uses Treasurer then Credit Committee then Chairman for NGN 500,001 and refuses skipping', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/approvals/requests')
      .set(auth(token))
      .send({
        kind: 'WITHDRAWAL',
        entityType: 'savings_withdrawal_request',
        entityId: randomUUID(),
        amount: 500001,
        summary: 'FR-020 upper-band boundary',
      })
      .expect(201);
    expect(created.body.steps).toMatchObject([
      { stepNo: 1, approverRoleCode: 'TREASURER' },
      { stepNo: 2, approverRoleCode: 'CREDIT_COMMITTEE' },
      { stepNo: 3, approverRoleCode: 'CHAIRMAN' },
    ]);

    const skip = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(chairmanToken))
      .send({ decision: 'APPROVE' });
    expect(skip.status).toBe(403);

    await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(treasurerToken))
      .send({ decision: 'APPROVE' })
      .expect(200)
      .expect(({ body }) => expect(body.nextApproverRoleCode).toBe('CREDIT_COMMITTEE'));
    await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(creditCommitteeToken))
      .send({ decision: 'APPROVE' })
      .expect(200)
      .expect(({ body }) => expect(body.nextApproverRoleCode).toBe('CHAIRMAN'));
    await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(chairmanToken))
      .send({ decision: 'APPROVE' })
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('APPROVED'));
  });

  it('allows an active, time-bounded delegate to act for a named approver', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const policy = await client.query<{ id: string }>(
        `INSERT INTO approval_policies
           (organization_id, kind, min_amount, max_amount, version, description, created_by)
         VALUES ($1, 'EXPENSE', 0, NULL, 1, 'Named approver delegation proof', $2)
         RETURNING id`,
        [orgId, requesterId],
      );
      await client.query(
        `INSERT INTO approval_policy_steps
           (organization_id, policy_id, step_no, approver_user_id, label)
         VALUES ($1, $2, 1, $3, 'Named Treasurer')`,
        [orgId, policy.rows[0]!.id, treasurerUserId],
      );
      await client.query(
        `INSERT INTO approval_delegations
           (organization_id, from_user_id, to_user_id, kind, valid_from, valid_to, created_by)
         VALUES ($1, $2, $3, 'EXPENSE', now() - interval '1 minute',
                 now() + interval '1 hour', $4)`,
        [orgId, treasurerUserId, chairmanUserId, requesterId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const created = await request(app.getHttpServer())
      .post('/api/v1/approvals/requests')
      .set(auth(token))
      .send({
        kind: 'EXPENSE',
        entityType: 'expense_claim',
        entityId: randomUUID(),
        amount: 75000,
        summary: 'Treasurer delegated during leave',
      })
      .expect(201);

    const delegated = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(chairmanToken))
      .send({ decision: 'APPROVE', comment: 'Acting for Treasurer' });
    expect(delegated.status).toBe(200);
    expect(delegated.body.status).toBe('APPROVED');
  });

  it('snapshots Treasurer then Chairman for a NGN 500,000 withdrawal request', async () => {
    const entityId = randomUUID();
    const created = await request(app.getHttpServer())
      .post('/api/v1/approvals/requests')
      .set(auth(token))
      .send({
        kind: 'WITHDRAWAL',
        entityType: 'savings_withdrawal_request',
        entityId,
        amount: 500000,
        summary: 'FR-020 lower-band boundary',
      });

    expect(created.status).toBe(201);
    lowerRequestId = created.body.id as string;
    expect(created.body).toMatchObject({
      kind: 'WITHDRAWAL',
      entityType: 'savings_withdrawal_request',
      entityId,
      amount: '500000.00',
      status: 'PENDING',
      policyVersion: 1,
      currentStep: 1,
      totalSteps: 2,
      steps: [
        { stepNo: 1, approverRoleCode: 'TREASURER', status: 'PENDING' },
        { stepNo: 2, approverRoleCode: 'CHAIRMAN', status: 'PENDING' },
      ],
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const trail = await client.query<{ action: string; actor_user_id: string }>(
        `SELECT action, actor_user_id FROM approval_actions WHERE request_id = $1`,
        [created.body.id],
      );
      await client.query('COMMIT');
      expect(trail.rows).toEqual([{ action: 'SUBMIT', actor_user_id: requesterId }]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  it('allows only the ordered role chain to approve and makes the final decision immutable', async () => {
    const first = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${lowerRequestId}/decisions`)
      .set(auth(treasurerToken))
      .send({ decision: 'APPROVE', comment: 'Treasurer checked the funds' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      id: lowerRequestId,
      status: 'PENDING',
      currentStep: 2,
      decidedStep: 1,
      nextApproverRoleCode: 'CHAIRMAN',
    });

    const final = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${lowerRequestId}/decisions`)
      .set(auth(chairmanToken))
      .send({ decision: 'APPROVE', comment: 'Chairman approved' });
    expect(final.status).toBe(200);
    expect(final.body).toMatchObject({
      id: lowerRequestId,
      status: 'APPROVED',
      currentStep: 2,
      decidedStep: 2,
      nextApproverRoleCode: null,
    });

    const replay = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${lowerRequestId}/decisions`)
      .set(auth(chairmanToken))
      .send({ decision: 'APPROVE' });
    expect(replay.status).toBe(409);
  });

  it('blocks an amount that no active policy covers', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/approvals/requests')
      .set(auth(token))
      .send({
        kind: 'WITHDRAWAL',
        entityType: 'savings_withdrawal_request',
        entityId: randomUUID(),
        amount: 2000001,
      });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('no active policy covers this amount');
  });

  it('blocks ambiguous configuration when two active policies overlap', async () => {
    const client = await pool.connect();
    let overlapId = '';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO approval_policies
           (organization_id, kind, min_amount, max_amount, version, description, created_by)
         VALUES ($1, 'WITHDRAWAL', 100, 200, 2, 'Deliberate overlap for refusal proof', $2)
         RETURNING id`,
        [orgId, requesterId],
      );
      overlapId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO approval_policy_steps
           (organization_id, policy_id, step_no, approver_role_code)
         VALUES ($1, $2, 1, 'TREASURER')`,
        [orgId, overlapId],
      );
      await client.query('COMMIT');

      const response = await request(app.getHttpServer())
        .post('/api/v1/approvals/requests')
        .set(auth(token))
        .send({
          kind: 'WITHDRAWAL',
          entityType: 'savings_withdrawal_request',
          entityId: randomUUID(),
          amount: 150,
        });
      expect(response.status).toBe(409);
      expect(response.body.message).toContain('active policies overlap');
    } finally {
      if (overlapId) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
        await client.query(`DELETE FROM approval_policies WHERE id = $1`, [overlapId]);
        await client.query('COMMIT');
      }
      client.release();
    }
  });

  it('refuses requester self-approval even when the requester holds approval permissions', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/approvals/requests')
      .set(auth(token))
      .send({
        kind: 'WITHDRAWAL',
        entityType: 'savings_withdrawal_request',
        entityId: randomUUID(),
        amount: 200,
      })
      .expect(201);
    const response = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(token))
      .send({ decision: 'APPROVE' });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain('different user');
  });

  it('lets the current authorized step reject the request and makes rejection final', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/approvals/requests')
      .set(auth(token))
      .send({
        kind: 'WITHDRAWAL',
        entityType: 'savings_withdrawal_request',
        entityId: randomUUID(),
        amount: 100,
        summary: 'Reject this request',
      })
      .expect(201);

    const rejected = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(treasurerToken))
      .send({ decision: 'REJECT', comment: 'Missing committee minutes' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      id: created.body.id,
      status: 'REJECTED',
      currentStep: 1,
      decidedStep: 1,
      nextApproverRoleCode: null,
    });

    const replay = await request(app.getHttpServer())
      .post(`/api/v1/approvals/requests/${created.body.id}/decisions`)
      .set(auth(treasurerToken))
      .send({ decision: 'APPROVE' });
    expect(replay.status).toBe(409);
  });
});
