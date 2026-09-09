import { Module } from '@nestjs/common';
import { OrgUsersController } from './org-users.controller';
import { OrgUsersService } from './org-users.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [OrgUsersController],
  providers: [OrgUsersService],
  exports: [OrgUsersService],
})
export class OrgUsersModule {}
