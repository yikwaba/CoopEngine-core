import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { PasswordResetService, RESET_RESPONSE } from '../src/auth/password-reset.service';
import { MfaFlowService } from '../src/auth/mfa-flow.service';
import { DB_POOL } from '../src/database/database.module';
const token = 'a'.repeat(64);

describe('password reset HTTP validation and response contract', () => {
  let app: INestApplication;
  const ask = vi.fn(async () => RESET_RESPONSE);
  const reset = vi.fn(async () => {});
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({})], controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: MfaFlowService, useValue: {} },
        { provide: PasswordResetService, useValue: { request: ask, reset } },
        { provide: DB_POOL, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => { await app?.close(); });
  it('request is public and exposes only the generic response', async () => {
    const result = await request(app.getHttpServer()).post('/auth/password-reset/request').send({ email: 'user@example.test' }).expect(202);
    expect(result.body).toEqual(RESET_RESPONSE);
    expect(ask).toHaveBeenCalledWith('user@example.test', expect.any(String));
  });
  for (const body of [{}, { email: 'invalid' }, { email: 'user@example.test', userId: 'chosen-user' }]) {
    it(`rejects invalid request ${JSON.stringify(body)}`, async () => {
      await request(app.getHttpServer()).post('/auth/password-reset/request').send(body).expect(400);
      expect(ask).not.toHaveBeenCalled();
    });
  }
  for (const body of [{ token, password: 'short' }, { token: 'bad', password: 'RecoveryPass123!' },
    { token, password: 'p'.repeat(73) }, { token, password: 'RecoveryPass123!', userId: 'chosen-user' }]) {
    it(`rejects invalid confirmation ${JSON.stringify(body)}`, async () => {
      await request(app.getHttpServer()).post('/auth/password-reset/confirm').send(body).expect(400);
      expect(reset).not.toHaveBeenCalled();
    });
  }
  it('confirmation returns no token/session and clears cookies', async () => {
    const result = await request(app.getHttpServer()).post('/auth/password-reset/confirm').send({ token, password: 'RecoveryPass123!' }).expect(204);
    expect(reset).toHaveBeenCalledWith(token, 'RecoveryPass123!');
    expect(result.text).toBe('');
    expect(result.headers['set-cookie']).toHaveLength(2);
  });
  it('rejects passwords beyond bcrypt byte capacity before database work', async () => {
    const connect = vi.fn();
    const service = new PasswordResetService({ connect } as never, {} as never);
    await expect(service.reset(token, 'é'.repeat(40))).rejects.toThrow('72 UTF-8 bytes');
    expect(connect).not.toHaveBeenCalled();
  });
});
