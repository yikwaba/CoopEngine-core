import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, RequestMethod, Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { MemberJwtGuard } from '../src/common/guards/member-jwt.guard';
import { PermissionsGuard } from '../src/common/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../src/common/decorators/permissions.decorator';

// Walk registered modules rather than a hand-maintained list of controllers.
function controllers(module: Type, visited = new Set<Type>()): Type[] {
  if (visited.has(module)) return [];
  visited.add(module);
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? [];
  return [
    ...(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? []),
    ...imports.flatMap((item: Type | { module?: Type }) => {
      const imported = typeof item === 'function' ? item : item.module;
      return imported ? controllers(imported, visited) : [];
    }),
  ];
}
const routes = controllers(AppModule).flatMap(controller =>
  Object.getOwnPropertyNames(controller.prototype).flatMap(name => {
    const handler = controller.prototype[name];
    const method = typeof handler === 'function' ? Reflect.getMetadata(METHOD_METADATA, handler) : undefined;
    if (method === undefined) return [];
    const path = [Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler)]
      .filter(Boolean).join('/').replace(/\/+$/g, '');
    return [{ controller, handler, label: `${RequestMethod[method]} /${path}` }];
  }),
);

// Explicitly reviewed exceptions. Adding an unprotected endpoint must fail CI
// until its authentication boundary is reviewed and recorded here.
const exceptions: Record<string, 'public' | 'session' | 'member' | 'internal-token' | 'webhook-signature'> = {
  'POST /auth/login': 'public',
  'POST /auth/mfa/login-verify': 'public',
  'POST /auth/refresh': 'public',
  'POST /auth/mfa/setup': 'session',
  'POST /auth/mfa/verify-setup': 'session',
  'POST /auth/mfa/disable': 'session',
  'POST /auth/logout': 'session',
  'GET /auth/me': 'session',
  'POST /auth/member/request-otp': 'public',
  'POST /auth/member/verify-otp': 'public',
  'POST /auth/member/logout': 'public',
  'GET /health': 'public',
  'POST /internal/notifications/dispatch': 'internal-token',
  'POST /internal/savings/sweep': 'internal-token',
  'POST /payments/monnify/webhook': 'webhook-signature',
};
const reflector = new Reflector();
function context(route: { controller: Type; handler: Function }, permissions: string[]): ExecutionContext {
  return {
    getHandler: () => route.handler,
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
  } as unknown as ExecutionContext;
}

describe('registered API permission boundaries', () => {
  it('discovers controllers and routes, with no stale explicit exceptions', () => {
    expect(routes.length).toBeGreaterThan(100);
    for (const label of Object.keys(exceptions)) expect(routes.some(r => r.label === label), label).toBe(true);
  });
  for (const route of routes) {
    it(`${route.label}: declared authentication and permission boundary`, () => {
      const guards = [
        ...(Reflect.getMetadata(GUARDS_METADATA, route.controller) ?? []),
        ...(Reflect.getMetadata(GUARDS_METADATA, route.handler) ?? []),
      ];
      const policy = reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [route.handler, route.controller]);
      if (policy !== undefined) {
        expect(policy.length).toBeGreaterThan(0);
        expect(guards).toContain(JwtAuthGuard);
        expect(guards).toContain(PermissionsGuard);
        expect(guards.indexOf(JwtAuthGuard)).toBeLessThan(guards.indexOf(PermissionsGuard));
        const guard = new PermissionsGuard(reflector);
        expect(() => guard.canActivate(context(route, []))).toThrow(ForbiddenException);
        expect(() => guard.canActivate(context(route, ['__unrelated_permission__']))).toThrow(ForbiddenException);
        for (const permission of policy) expect(guard.canActivate(context(route, [permission]))).toBe(true);
        return;
      }
      if (guards.includes(MemberJwtGuard)) {
        expect(route.label).toMatch(/^(GET|POST|PATCH|DELETE|PUT) \/member\//);
        expect(guards).not.toContain(PermissionsGuard);
        return;
      }
      const exception = exceptions[route.label];
      expect(exception, 'Unreviewed route without a permission policy').toBeDefined();
      if (exception === 'session') expect(guards).toContain(JwtAuthGuard);
      expect(guards).not.toContain(PermissionsGuard);
    });
  }
});

describe('permission guard fails closed on missing policy', () => {
  for (const required of [undefined, []]) {
    it(`rejects ${required === undefined ? 'missing' : 'empty'} policy even with privileges`, () => {
      const metadata = { getAllAndOverride: () => required } as unknown as Reflector;
      expect(() => new PermissionsGuard(metadata).canActivate(context({ controller: AppModule, handler: () => {} }, ['products.manage']))).toThrow(ForbiddenException);
    });
  }
});
