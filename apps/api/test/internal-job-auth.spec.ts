import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalsInternalController } from '../src/goals/goals.module';
import { GoalsService } from '../src/goals/goals.service';
import { NotificationsInternalController } from '../src/notifications/notifications.internal.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { DB_POOL } from '../src/database/database.module';

const paths = ['/internal/savings/sweep', '/internal/notifications/dispatch'];
describe('internal jobs authenticate before tenant scans or side effects', () => {
  let app: INestApplication;
  const original = process.env.INTERNAL_CRON_TOKEN;
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id FROM organizations') ? [{ id: 'tenant-a' }] : [] }));
  const connect = vi.fn(async () => ({ query, release: vi.fn() }));
  const sweepDue = vi.fn(async () => ({ reminded: 1 }));
  const dispatchPending = vi.fn(async () => ({ attempted: 1, sent: 1, failed: 0 }));
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [GoalsInternalController, NotificationsInternalController],
      providers: [
        { provide: DB_POOL, useValue: { connect } },
        { provide: GoalsService, useValue: { sweepDue } },
        { provide: NotificationsService, useValue: { dispatchPending } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  beforeEach(() => { vi.clearAllMocks(); process.env.INTERNAL_CRON_TOKEN = 'unit-test-machine-token'; });
  afterAll(async () => {
    await app?.close();
    if (original === undefined) delete process.env.INTERNAL_CRON_TOKEN;
    else process.env.INTERNAL_CRON_TOKEN = original;
  });
  for (const path of paths) {
    for (const token of [undefined, 'incorrect-token']) {
      it(`${path}: rejects ${token === undefined ? 'missing' : 'wrong'} token before work`, async () => {
        let req = request(app.getHttpServer()).post(path);
        if (token) req = req.set('x-internal-token', token);
        await req.send({}).expect(401);
        expect(connect).not.toHaveBeenCalled();
        expect(sweepDue).not.toHaveBeenCalled();
        expect(dispatchPending).not.toHaveBeenCalled();
      });
    }
    it(`${path}: missing configured token fails closed`, async () => {
      delete process.env.INTERNAL_CRON_TOKEN;
      await request(app.getHttpServer()).post(path).set('x-internal-token', 'unit-test-machine-token').send({}).expect(401);
      expect(connect).not.toHaveBeenCalled();
      expect(sweepDue).not.toHaveBeenCalled();
      expect(dispatchPending).not.toHaveBeenCalled();
    });
    it(`${path}: configured token permits the intended job`, async () => {
      await request(app.getHttpServer()).post(path).set('x-internal-token', 'unit-test-machine-token').send({}).expect(201);
      expect(connect).toHaveBeenCalledOnce();
      if (path.endsWith('/sweep')) expect(sweepDue).toHaveBeenCalledWith('tenant-a', null);
      else expect(dispatchPending).toHaveBeenCalledWith('tenant-a', null, {});
    });
  }
});
