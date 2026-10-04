import { APP_INTERCEPTOR } from '@nestjs/core';
import { MfaClock } from './mfa-clock';
import { SensitiveActionInterceptor } from './sensitive-action';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { MfaFlowService } from './mfa-flow.service';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetMailer } from './password-reset-mailer';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [MfaClock, {provide: APP_INTERCEPTOR, useClass: SensitiveActionInterceptor}, MfaFlowService, AuthService, PasswordResetService, PasswordResetMailer],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
