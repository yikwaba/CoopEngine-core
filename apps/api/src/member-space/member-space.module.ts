import { Module } from '@nestjs/common';
import { MemberSpaceController } from './member-space.controller';
import { MemberSpaceService } from './member-space.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MemberSpaceController],
  providers: [MemberSpaceService],
  exports: [MemberSpaceService],
})
export class MemberSpaceModule {}
