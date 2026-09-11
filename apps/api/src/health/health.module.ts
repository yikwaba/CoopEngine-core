import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HealthController, ProviderStatusService } from './health.controller';

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [ProviderStatusService],
})
export class HealthModule {}
