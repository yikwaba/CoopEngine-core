import { Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MemberImportService } from './member-import.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MembersController],
  providers: [MembersService, MemberImportService],
  exports: [MembersService],
})
export class MembersModule {}
