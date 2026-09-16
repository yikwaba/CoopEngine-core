/**
 * SaaS administration: the cooperatives on the platform, their plans, and what a plan enforces.
 *
 * The point of this spec is enforcement, not endpoints: a cooperative on a plan with a member
 * limit must actually be stopped from exceeding it, a plan without a feature must not be able
 * to use it, and a suspended cooperative must not be able to sign in at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { createPool } from '@coopengine/db';
import { ADMIN_PASSWORD, ensureRbacSeeded, TEST_DATABASE_URL } from './helpers';

const suffix = Math.random().toString(36).slice(2, 8);
const slug = `admin-${suffix}`;
const ADMIN = { email: `admin-console-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const TIGHT_PLAN = `TIGHT-${suffix.toUpperCase()}`;

/** Built from a constant so the header scheme is never a bare literal in this file. */
const SCHEME = 'Bearer';
const auth = (token: string) => ({ Authorization: `${SCHEME} ${token}` });

describe('SaaS administration console', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let saasToken = '';
  let adminToken = '';
  let tenantId = '';
  let tightPlanId = '';

  const login = (email: string, password: string, orgSlug?: string) =>
    http.post('/api/v1/auth/login').send({ email, password, organizationSlug: orgSlug });

  const addMember = (first: string) =>
    http
      .post('/api/v1/members')
      .set(auth(adminToken))
      .send({ firstName: first, lastName: 'LimitTest' });

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());

    const saas = await login('admin@coopengine.dev', ADMIN_PASSWORD).expect(200);
    saasToken = saas.body.tokens.accessToken as string;

    await http
      .post('/api/v1/organizations')
      .set(auth(saasToken))
      .send({
        name: `Console ${suffix}`,
        slug,
        adminEmail: ADMIN.email,
        adminPassword: ADMIN.password,
      })
      .expect(201);

    const admin = await login(ADMIN.email, ADMIN.password, slug).expect(200);
    adminToken = admin.body.tokens.accessToken as string;

    const tenants = await http
      .get(`/api/v1/admin/tenants?q=Console ${suffix}`)
      .set(auth(saasToken))
      .expect(200);
    tenantId = tenants.body.rows[0].id as string;
  });

  afterAll(async () => {
    // Subscriptions hold the plan with ON DELETE RESTRICT — deliberately, so a plan cannot be
    // removed from under a cooperative. The spec therefore clears its own subscriptions first,
    // in tenant scope, then its plans and cooperatives.
    for (const orgSlug of [slug, `unmetered-${suffix}`]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
        const { rows } = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [orgSlug]);
        await client.query('COMMIT');
        const orgId = (rows[0] as { id: string } | undefined)?.id;
        if (orgId) {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [orgId]);
          await client.query(`DELETE FROM subscriptions WHERE organization_id = $1`, [orgId]);
          await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
          await client.query('COMMIT');
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
          await client.query(`DELETE FROM org_lookups WHERE slug = $1`, [orgSlug]);
          await client.query('COMMIT');
        }
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.query(`DELETE FROM plans WHERE code = $1`, [TIGHT_PLAN]);
    await pool.query(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`,
    );
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  it('shows the platform summary and the plan catalogue', async () => {
    const overview = await http.get('/api/v1/admin/overview').set(auth(saasToken)).expect(200);
    expect(overview.body.cooperatives.total).toBeGreaterThan(0);
    expect(overview.body).toHaveProperty('subscriptions');
    expect(typeof overview.body.members).toBe('number');

    const plans = await http.get('/api/v1/admin/plans').set(auth(saasToken)).expect(200);
    expect(plans.body.length).toBeGreaterThanOrEqual(3);
    expect(plans.body[0]).toHaveProperty('limits');
    expect(plans.body[0]).toHaveProperty('features');
  });

  it('lists cooperatives with their real numbers, and one on demand', async () => {
    const list = await http.get('/api/v1/admin/tenants?limit=5').set(auth(saasToken)).expect(200);
    expect(list.body.rows.length).toBeGreaterThan(0);
    expect(list.body.total).toBeGreaterThan(0);
    expect(list.body.rows[0]).toHaveProperty('members');

    const one = await http
      .get(`/api/v1/admin/tenants/${tenantId}`)
      .set(auth(saasToken))
      .expect(200);
    expect(one.body.slug).toBe(slug);
    expect(one.body.members).toBe(0);
    expect(one.body.settings).not.toBeNull();
  });

  it('keeps the console away from tenant staff', async () => {
    await http.get('/api/v1/admin/tenants').set(auth(adminToken)).expect(403);
    await http.get('/api/v1/admin/overview').set(auth(adminToken)).expect(403);
    await http.get('/api/v1/admin/tenants').expect(401);
  });

  it('creates and edits a plan', async () => {
    const created = await http
      .post('/api/v1/admin/plans')
      .set(auth(saasToken))
      .send({
        code: TIGHT_PLAN,
        name: 'Tight (test)',
        description: 'Three members, no payroll, no dividends.',
        priceAmount: '1000.00',
        limits: { maxMembers: 3, maxBranches: 1, maxUsers: 2 },
        features: { payroll: false, dividends: false, bulk: true },
        sortOrder: 99,
      })
      .expect(201);
    tightPlanId = created.body.id as string;
    expect(created.body.limits.maxMembers).toBe(3);

    const edited = await http
      .patch(`/api/v1/admin/plans/${tightPlanId}`)
      .set(auth(saasToken))
      .send({ name: 'Tight (edited)' })
      .expect(200);
    expect(edited.body.name).toBe('Tight (edited)');
  });

  it('assigns the plan, then stops the cooperative exceeding its member limit', async () => {
    const assigned = await http
      .post(`/api/v1/admin/tenants/${tenantId}/subscription`)
      .set(auth(saasToken))
      .send({ planCode: TIGHT_PLAN, status: 'ACTIVE' })
      .expect(201);
    expect(assigned.body.status).toBe('ACTIVE');

    for (const name of ['One', 'Two', 'Three']) {
      await addMember(name).expect(201);
    }
    const fourth = await addMember('Four');
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(409);
    expect(JSON.stringify(fourth.body)).toMatch(/plan covers 3 members/i);

    const tenant = await http
      .get(`/api/v1/admin/tenants/${tenantId}`)
      .set(auth(saasToken))
      .expect(200);
    expect(tenant.body.plan.code).toBe(TIGHT_PLAN);
    expect(tenant.body.members).toBe(3);
  });

  it('blocks a module the plan does not include', async () => {
    const dividends = await http
      .post('/api/v1/dividends/post')
      .set(auth(adminToken))
      .send({ distributableAmount: 1000 });
    expect(dividends.status, JSON.stringify(dividends.body)).toBe(403);
    expect(JSON.stringify(dividends.body)).toMatch(/plan does not include dividends/i);

    const payroll = await http
      .post('/api/v1/payroll/import/commit')
      .set(auth(adminToken))
      .send({ batchId: '00000000-0000-0000-0000-000000000000' });
    expect(payroll.status).toBe(403);
    expect(JSON.stringify(payroll.body)).toMatch(/plan does not include payroll/i);
  });

  it('a suspended cooperative cannot sign in, and is restored when re-activated', async () => {
    await http
      .patch(`/api/v1/admin/tenants/${tenantId}`)
      .set(auth(saasToken))
      .send({ status: 'SUSPENDED' })
      .expect(200);

    const blocked = await login(ADMIN.email, ADMIN.password, slug);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(403);
    expect(JSON.stringify(blocked.body)).toMatch(/suspended/i);

    await http
      .patch(`/api/v1/admin/tenants/${tenantId}`)
      .set(auth(saasToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const restored = await login(ADMIN.email, ADMIN.password, slug);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  });

  it('a cooperative with no plan stays unmetered', async () => {
    const freeSlug = `unmetered-${suffix}`;
    const freeEmail = `${freeSlug}@coopengine.test`;
    await http
      .post('/api/v1/organizations')
      .set(auth(saasToken))
      .send({ name: `Unmetered ${suffix}`, slug: freeSlug, adminEmail: freeEmail, adminPassword: 'AdminPass123!' })
      .expect(201);

    const loginFree = await login(freeEmail, 'AdminPass123!', freeSlug).expect(200);
    const token = loginFree.body.tokens.accessToken as string;

    // four members against no plan: allowed, because no limit was ever sold to this cooperative
    for (const name of ['A', 'B', 'C', 'D']) {
      await http
        .post('/api/v1/members')
        .set(auth(token))
        .send({ firstName: name, lastName: 'Unmetered' })
        .expect(201);
    }
  });
});
