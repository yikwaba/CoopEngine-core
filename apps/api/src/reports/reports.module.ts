import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { BoardPackXlsxService } from './board-pack-xlsx.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [ReportsService, BoardPackXlsxService],
  exports: [ReportsService],
})
export class ReportsModule {}
