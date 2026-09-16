/**
 * Who may READ the member list.
 *
 * Regression guard: the read endpoints required the mutation permissions, so the treasurer,
 * loan officer and auditor — roles that must see members to do their jobs — were refused,
 * while the actual read permission (members.lookup) was not accepted anywhere in this
 * controller. Reading is now gated on members.lookup; changing still needs the write
 * permissions.
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
const ADMIN = { email: `mread-${suffix}@coopengine.test`, password: 'AdminPass123!' };
const STAFF = {
  treasurer: `mread-t-${suffix}@coopengine.test`,
  auditor: `mread-a-${suffix}@coopengine.test`,
};

describe('member read permissions by role', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let pool: Pool;
  let adminToken = '';
  let treasurerToken = '';
  let auditorToken = '';
  let memberId = '';
  const slug = `mread-${suffix}`;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    // The RBAC seeder only runs when roles are absent, so a database that already has them
    // keeps its old grants. Apply the catalogue entry this spec depends on, exactly as the
    // seeded catalogue defines it (a no-op on a database seeded with the current catalogue).
    for (const role of ['TREASURER', 'LOAN_OFFICER', 'AUDITOR']) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p
          WHERE r.code = $1 AND r.scope = 'org' AND p.code = 'members.lookup'
         ON CONFLICT DO NOTHING`,
        [role],
      );
    }
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
      .set({ Authorization: `Bearer ${saas.body.tokens.accessToken}` })
      .send({ name: `Read ${suffix}`, slug, adminEmail: ADMIN.email, adminPassword: ADMIN.password })
      .expect(201);

    const admin = await http
      .post('/api/v1/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password, organizationSlug: slug })
      .expect(200);
    adminToken = admin.body.tokens.accessToken as string;

    // one member for the roles to read
    const created = await http
      .post('/api/v1/members')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ firstName: 'Read', lastName: 'Target', email: `mread-m-${suffix}@coopengine.test`, phone: '+2348030000001' })
      .expect(201);
    memberId = created.body.id as string;

    // staff in the two roles under test (invites return a one-time password)
    for (const [role, email] of [['TREASURER', STAFF.treasurer], ['AUDITOR', STAFF.auditor]] as const) {
      const invited = await http
        .post('/api/v1/users')
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ email, roleCodes: [role] })
        .expect(201);
      const pw = invited.body.tempPassword as string;
      const login = await http
        .post('/api/v1/auth/login')
        .send({ email, password: pw, organizationSlug: slug })
        .expect(200);
      if (role === 'TREASURER') treasurerToken = login.body.tokens.accessToken as string;
      else auditorToken = login.body.tokens.accessToken as string;
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@coopengine.test')`);
    await pool.query(`DELETE FROM users WHERE email LIKE '%@coopengine.test'`);
    await app?.close();
    await pool.end();
  });

  it('a treasurer can list members and read one', async () => {
    const list = await http.get('/api/v1/members').set({ Authorization: `Bearer ${treasurerToken}` });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    const one = await http
      .get(`/api/v1/members/${memberId}`)
      .set({ Authorization: `Bearer ${treasurerToken}` });
    expect(one.status).toBe(200);
  });

  it('an auditor can read members too', async () => {
    const list = await http.get('/api/v1/members').set({ Authorization: `Bearer ${auditorToken}` });
    expect(list.status).toBe(200);
  });

  it('reading a member does not confer the right to change one', async () => {
    // the treasurer may read, but must not create or approve
    await http
      .post('/api/v1/members')
      .set({ Authorization: `Bearer ${treasurerToken}` })
      .send({ firstName: 'Should', lastName: 'Fail' })
      .expect(403);
    await http
      .post(`/api/v1/members/${memberId}/approve`)
      .set({ Authorization: `Bearer ${treasurerToken}` })
      .send({})
      .expect(403);
    await http
      .post(`/api/v1/members/${memberId}/suspend`)
      .set({ Authorization: `Bearer ${treasurerToken}` })
      .send({})
      .expect(403);
  });

  it('a role with neither read nor write permission is still refused', async () => {
    // no token at all, and a token for a role without member rights (auditor cannot write)
    await http.get('/api/v1/members').expect(401);
    await http
      .post('/api/v1/members')
      .set({ Authorization: `Bearer ${auditorToken}` })
      .send({ firstName: 'No', lastName: 'Chance' })
      .expect(403);
  });
});
