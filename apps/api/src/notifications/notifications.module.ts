import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsInternalController } from './notifications.internal.controller';
import { NotificationsService } from './notifications.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController, NotificationsInternalController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
