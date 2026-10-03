import 'reflect-metadata';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportsController } from '../src/reports/reports.controller';
import { ReportsService } from '../src/reports/reports.service';
import { BoardPackXlsxService } from '../src/reports/board-pack-xlsx.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../src/common/guards/permissions.guard';

describe('audit log HTTP query validation', () => {
  let app: INestApplication;
  const auditLogs = vi.fn(async () => ({ items: [], total: 3 }));

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        { provide: ReportsService, useValue: { auditLogs } },
        { provide: BoardPackXlsxService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().user = { organizationId: 'synthetic-tenant' };
        return true;
      } })
      .overrideGuard(PermissionsGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  beforeEach(() => auditLogs.mockClear());
  afterAll(async () => { await app?.close(); });

  it('accepts the exact portal query and forwards numeric pagination', async () => {
    const result = await request(app.getHttpServer()).get('/reports/audit-logs?limit=25&offset=0').expect(200);
    expect(result.body).toEqual([]);
    expect(result.headers['x-total-count']).toBe('3');
    expect(auditLogs).toHaveBeenCalledWith('synthetic-tenant', 25, undefined, 0);
  });

  it('accepts an action filter with pagination', async () => {
    await request(app.getHttpServer()).get('/reports/audit-logs?limit=25&offset=25&action=member.approved').expect(200);
    expect(auditLogs).toHaveBeenCalledWith('synthetic-tenant', 25, 'member.approved', 25);
  });

  it('allows omitted optional pagination', async () => {
    await request(app.getHttpServer()).get('/reports/audit-logs').expect(200);
    expect(auditLogs).toHaveBeenCalledWith('synthetic-tenant', undefined, undefined, undefined);
  });

  it.each(['limit=abc', 'limit=1.5', 'limit=0', 'limit=501', 'offset=-1', 'offset=1.5', 'unexpected=1'])(
    'rejects invalid pagination or unknown query: %s', async query => {
      await request(app.getHttpServer()).get(`/reports/audit-logs?${query}`).expect(400);
      expect(auditLogs).not.toHaveBeenCalled();
    },
  );
});
