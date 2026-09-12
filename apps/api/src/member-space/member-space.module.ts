import { Module } from '@nestjs/common';
import { MemberSpaceController } from './member-space.controller';
import { MemberSpaceService } from './member-space.service';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';
import { SavingsModule } from '../savings/savings.module';
import { GoalsModule } from '../goals/goals.module';
import { PdfModule } from '../pdf/pdf.module';

@Module({
  imports: [AuthModule, DocumentsModule, GoalsModule, SavingsModule, PdfModule],
  controllers: [MemberSpaceController],
  providers: [MemberSpaceService],
  exports: [MemberSpaceService],
})
export class MemberSpaceModule {}
