import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetMailer } from './password-reset-mailer';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordResetService, PasswordResetMailer],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
