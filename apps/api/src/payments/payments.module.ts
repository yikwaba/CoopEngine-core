import { Module } from '@nestjs/common';
import { PaymentsController, PaymentsInternalController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController, PaymentsInternalController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
