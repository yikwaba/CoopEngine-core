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
});
