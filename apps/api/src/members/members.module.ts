import { Module } from '@nestjs/common';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MemberImportService } from './member-import.service';
import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AuthModule, AdminModule],
  controllers: [MembersController],
  providers: [MembersService, MemberImportService],
  exports: [MembersService],
})
export class MembersModule {}
