/**
 * OpenAPI contract test: the generated spec must advertise the routes that
 * staff and member clients depend on, so documentation cannot silently
 * drift from the controllers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

describe('OpenAPI contract', () => {
  it('advertises every product surface in the generated spec', () => {
    const config = new DocumentBuilder().setTitle('Co-opEngine API').setVersion('0.1.0').build();
    const doc = SwaggerModule.createDocument(app, config);
    const paths = Object.keys(doc.paths ?? {}).map((p) => p.replace(/\{/g, ':').replace(/\}/g, ''));

    const required = [
      '/api/v1/health',
      // staff identity & orgs
      '/api/v1/auth/login',
      '/api/v1/auth/mfa/setup',
      '/api/v1/organizations',
      // membership + import + exit
      '/api/v1/members',
      '/api/v1/members/import/preview',
      '/api/v1/members/:id/exit',
      // staff user administration
      '/api/v1/users',
      '/api/v1/users/roles',
      '/api/v1/users/status',
      // money movement + ledger
      '/api/v1/savings/accounts/:id/deposits',
      '/api/v1/savings/interest/preview',
      '/api/v1/savings/interest/post',
      '/api/v1/loans',
      '/api/v1/loans/:id/repayments',
      '/api/v1/payroll/import/preview',
      '/api/v1/payroll/import/commit',
      '/api/v1/ledger/journals',
      '/api/v1/ledger/trial-balance',
      '/api/v1/shares/member/:memberId/redemptions',
      // reports
      '/api/v1/reports/member/:memberId/360',
      '/api/v1/reports/loans-aging',
      '/api/v1/reports/audit-logs',
      // member self-service
      '/api/v1/auth/member/request-otp',
      '/api/v1/auth/member/verify-otp',
      '/api/v1/member/dashboard',
    ];

    const missing = required.filter((r) => !paths.includes(r));
    expect(missing, `Spec missing routes:\n${missing.join('\n')}`).toEqual([]);
  });
});
