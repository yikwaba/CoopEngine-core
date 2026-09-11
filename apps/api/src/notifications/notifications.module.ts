import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsInternalController } from './notifications.internal.controller';
import { NotificationsService } from './notifications.service';
import { NotificationTemplatesService } from './templates.service';
import { NotificationTemplatesController } from './templates.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController, NotificationsInternalController, NotificationTemplatesController],
  providers: [NotificationsService, NotificationTemplatesService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
