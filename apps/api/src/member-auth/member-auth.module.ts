import { Module } from '@nestjs/common';
import { MemberAuthController } from './member-auth.controller';
import { MemberAuthService } from './member-auth.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MemberAuthController],
  providers: [MemberAuthService],
  exports: [MemberAuthService],
})
export class MemberAuthModule {}
