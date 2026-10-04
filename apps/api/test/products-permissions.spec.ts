import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductsController } from '../src/products/products.controller';
import { ProductsService } from '../src/products/products.service';
import { DB_POOL } from '../src/database/database.module';
import { ENV } from '../src/config/env';

const id = '11111111-1111-4111-8111-111111111111';
const savings = { code: 'TEST', name: 'Test savings', interestRatePa: 0, minDeposit: 0, allowWithdrawal: true };
const loan = { code: 'TEST', name: 'Test loan', interestRatePa: 15, interestMethod: 'FLAT', multiplier: 3, minPrincipal: 0, maxPrincipal: null };
const routes = [
  { method: 'get', path: '/products/savings', call: 'listSavings', permission: 'products.view', status: 200 },
  { method: 'get', path: '/products/loans', call: 'listLoans', permission: 'products.view', status: 200 },
  { method: 'post', path: '/products/savings', call: 'createSavings', body: savings, permission: 'products.manage', status: 201 },
  { method: 'post', path: '/products/loans', call: 'createLoan', body: loan, permission: 'products.manage', status: 201 },
  { method: 'patch', path: `/products/savings/${id}`, call: 'updateSavings', body: savings, permission: 'products.manage', status: 200 },
  { method: 'patch', path: `/products/loans/${id}`, call: 'updateLoan', body: loan, permission: 'products.manage', status: 200 },
  { method: 'post', path: `/products/savings/${id}/status`, call: 'setStatus', body: { status: 'INACTIVE' }, permission: 'products.manage', status: 201 },
  { method: 'post', path: `/products/loans/${id}/status`, call: 'setStatus', body: { status: 'INACTIVE' }, permission: 'products.manage', status: 201 },
] as const;

describe('product permissions over HTTP (real JWT and permission guards)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const service = Object.fromEntries([...new Set(routes.map(r => r.call))].map(name => [name, vi.fn(async () => ({ id }))]));
  let databasePermissions: string[] = [];
  const pool = { query: vi.fn(async () => ({ rows: [{ id: 'session', user_id: 'user', organization_id: 'tenant-a', revoked_at: null, memberships: 1, permissions: databasePermissions, roles: [], mfa_verified: true, mfa_enabled: true }] })) };
  const token = (permissions: string[]) => {
    databasePermissions = permissions;
    return jwt.sign({ sub: 'user', sid: 'session', org: 'tenant-a', perms: permissions }, { secret: ENV.jwtAccessSecret });
  };
  function send(route: typeof routes[number], accessToken?: string, cookie = false) {
    const agent = request(app.getHttpServer());
    let result = route.method === 'get' ? agent.get(route.path) : route.method === 'patch' ? agent.patch(route.path) : agent.post(route.path);
    if (accessToken) result = result.set(cookie ? 'Cookie' : 'Authorization', cookie ? `ce_at=${accessToken}` : `Bearer ${accessToken}`);
    if ('body' in route) result = result.send(route.body);
    return result;
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      controllers: [ProductsController],
      providers: [{ provide: ProductsService, useValue: service }, { provide: DB_POOL, useValue: pool }],
    }).compile();
    jwt = module.get(JwtService);
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => { await app?.close(); });

  for (const route of routes) {
    it(`${route.method} ${route.path}: unauthenticated is 401`, async () => {
      await send(route).expect(401);
      expect(service[route.call]).not.toHaveBeenCalled();
    });
    it(`${route.method} ${route.path}: no permissions is 403`, async () => {
      await send(route, token([])).expect(403);
      expect(service[route.call]).not.toHaveBeenCalled();
    });
    it(`${route.method} ${route.path}: unrelated permission is 403`, async () => {
      await send(route, token(['settings.manage'])).expect(403);
      expect(service[route.call]).not.toHaveBeenCalled();
    });
    it(`${route.method} ${route.path}: exact required permission is allowed`, async () => {
      await send(route, token([route.permission])).expect(route.status);
      expect(service[route.call]).toHaveBeenCalledOnce();
      expect(service[route.call].mock.calls[0][0]).toBe('tenant-a');
    });
    it(`${route.method} ${route.path}: opposite product permission cannot substitute`, async () => {
      const other = route.permission === 'products.view' ? 'products.manage' : 'products.view';
      await send(route, token([other])).expect(403);
      expect(service[route.call]).not.toHaveBeenCalled();
    });
  }
  it('browser cookie with products.view can list', async () => {
    await send(routes[0], token(['products.view']), true).expect(200);
  });
  it('browser cookie with view-only permission cannot create', async () => {
    await send(routes[2], token(['products.view']), true).expect(403);
    expect(service.createSavings).not.toHaveBeenCalled();
  });
  it('tampered JWT cannot gain manage permission', async () => {
    const [header, , signature] = token([]).split('.');
    const payload = Buffer.from(JSON.stringify({ sub: 'user', sid: 'session', org: 'tenant-a', perms: ['products.manage'] })).toString('base64url');
    await send(routes[2], `${header}.${payload}.${signature}`).expect(401);
    expect(service.createSavings).not.toHaveBeenCalled();
  });
});
