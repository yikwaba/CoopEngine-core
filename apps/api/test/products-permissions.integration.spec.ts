import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { createPool, withTenant } from '@coopengine/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ENV } from '../src/config/env';
import { JwtClaims } from '../src/common/auth.types';
import { ADMIN_PASSWORD, TEST_DATABASE_URL, ensureRbacSeeded } from './helpers';

describe('product permissions and tenant isolation (real PostgreSQL)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jwt: JwtService;
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = createPool(TEST_DATABASE_URL);
    await ensureRbacSeeded(pool);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    jwt = module.get(JwtService);
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function onboard(platformToken: string) {
    const suffix = randomUUID().slice(0, 8);
    const email = `product-permissions-${suffix}@coopengine.test`;
    const response = await request(app.getHttpServer()).post('/api/v1/organizations')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ name: `Product permission test ${suffix}`, slug: `product-permissions-${suffix}`, adminEmail: email, adminPassword: 'CoopPass123!' })
      .expect(201);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ email, password: 'CoopPass123!' }).expect(200);
    return { id: response.body.id as string, token: login.body.tokens.accessToken as string };
  }

  async function snapshot(orgId: string) {
    return withTenant(pool, orgId, async c => ({
      savings: (await c.query('SELECT * FROM savings_products ORDER BY id')).rows,
      loans: (await c.query('SELECT * FROM loan_products ORDER BY id')).rows,
      audit: (await c.query('SELECT * FROM audit_logs WHERE organization_id=$1 ORDER BY id', [orgId])).rows,
    }));
  }

  it('denies unauthorized writes without persistence changes and retains authorized tenant-scoped writes', async () => {
    const platform = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .send({ email: 'admin@coopengine.dev', password: ADMIN_PASSWORD }).expect(200);
    const a = await onboard(platform.body.tokens.accessToken);
    const b = await onboard(platform.body.tokens.accessToken);
    const claims = await jwt.verifyAsync<JwtClaims>(a.token, { secret: ENV.jwtAccessSecret });
    // Separate persisted users/roles exercise current grants. Changing only a
    // signed JWT snapshot no longer changes the server's authorization.
    const restricted = async (perms: string[]) => {
      const suffix = randomUUID().slice(0, 8);
      const email = `restricted-product-${suffix}@coopengine.test`;
      const userId = (await pool.query(`INSERT INTO users(email,password_hash)
        SELECT $1,password_hash FROM users WHERE id=$2 RETURNING id`, [email, claims.sub])).rows[0].id;
      const roleId = (await pool.query(`INSERT INTO roles(organization_id,code,name,scope)
        VALUES ($1,$2,'Product permission fixture','org') RETURNING id`, [a.id, `PRODUCT_${suffix}`])).rows[0].id;
      await pool.query('INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])', [roleId, perms]);
      await pool.query('INSERT INTO user_roles(user_id,organization_id,role_id) VALUES ($1,$2,$3)', [userId, a.id, roleId]);
      const login = await request(app.getHttpServer()).post('/api/v1/auth/login')
        .send({ email, password: 'CoopPass123!' }).expect(200);
      // Even an over-granted signed snapshot must not override DB restrictions.
      const current = await jwt.verifyAsync<JwtClaims>(login.body.tokens.accessToken, { secret: ENV.jwtAccessSecret });
      return jwt.sign({ ...current, perms: claims.perms }, { secret: ENV.jwtAccessSecret });
    };
    const noPermissions = await restricted([]);
    const viewer = await restricted(['products.view']);
    const id = randomUUID();
    const savings = { code: 'TEST-SAVE', name: 'Permission test savings', interestRatePa: 0, minDeposit: 0, allowWithdrawal: true };
    const loan = { code: 'TEST-LOAN', name: 'Permission test loan', interestRatePa: 15, interestMethod: 'FLAT', multiplier: 3, minPrincipal: 0, maxPrincipal: null };
    const writes = [
      { method: 'post', path: '/products/savings', body: savings },
      { method: 'post', path: '/products/loans', body: loan },
      { method: 'patch', path: `/products/savings/${id}`, body: savings },
      { method: 'patch', path: `/products/loans/${id}`, body: loan },
      { method: 'post', path: `/products/savings/${id}/status`, body: { status: 'INACTIVE' } },
      { method: 'post', path: `/products/loans/${id}/status`, body: { status: 'INACTIVE' } },
    ];
    const before = await snapshot(a.id);
    for (const write of writes) {
      for (const accessToken of [undefined, noPermissions, viewer]) {
        const agent = request(app.getHttpServer());
        let query = write.method === 'patch' ? agent.patch(`/api/v1${write.path}`) : agent.post(`/api/v1${write.path}`);
        if (accessToken) query = query.set('Authorization', `Bearer ${accessToken}`);
        await query.send(write.body).expect(accessToken ? 403 : 401);
      }
    }
    expect(await snapshot(a.id)).toEqual(before);
    for (const kind of ['savings', 'loans']) {
      await request(app.getHttpServer()).get(`/api/v1/products/${kind}`).set('Authorization', `Bearer ${noPermissions}`).expect(403);
      await request(app.getHttpServer()).get(`/api/v1/products/${kind}`).set('Authorization', `Bearer ${viewer}`).expect(200);
    }

    for (const [kind, body] of [['savings', savings], ['loans', loan]] as const) {
      const created = await request(app.getHttpServer()).post(`/api/v1/products/${kind}`)
        .set('Authorization', `Bearer ${a.token}`).send(body).expect(201);
      const productId = created.body.id as string;
      await request(app.getHttpServer()).patch(`/api/v1/products/${kind}/${productId}`)
        .set('Authorization', `Bearer ${a.token}`).send({ ...body, name: 'Updated permission test' }).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/products/${kind}/${productId}/status`)
        .set('Authorization', `Bearer ${a.token}`).send({ status: 'INACTIVE' }).expect(201);

      const beforeCrossTenant = await snapshot(a.id);
      await request(app.getHttpServer()).patch(`/api/v1/products/${kind}/${productId}`)
        .set('Authorization', `Bearer ${b.token}`).send({ ...body, name: 'Forbidden cross-tenant edit' }).expect(404);
      await request(app.getHttpServer()).post(`/api/v1/products/${kind}/${productId}/status`)
        .set('Authorization', `Bearer ${b.token}`).send({ status: 'ACTIVE' }).expect(404);
      expect(await snapshot(a.id)).toEqual(beforeCrossTenant);
      const ownList = await request(app.getHttpServer()).get(`/api/v1/products/${kind}`).set('Authorization', `Bearer ${a.token}`).expect(200);
      expect(ownList.body.find((p: { id: string }) => p.id === productId)).toMatchObject({ name: 'Updated permission test', status: 'INACTIVE' });
      const otherList = await request(app.getHttpServer()).get(`/api/v1/products/${kind}`).set('Authorization', `Bearer ${b.token}`).expect(200);
      expect(otherList.body.some((p: { id: string }) => p.id === productId)).toBe(false);
    }
    const after = await snapshot(a.id);
    expect(after.audit.length - before.audit.length).toBe(6);
  });
});
