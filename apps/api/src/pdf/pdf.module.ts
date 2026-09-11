import {
  Controller,
  Get,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';
import type { Response } from 'express';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthPrincipal } from '../common/auth.types';
import { PdfService } from './pdf.service';

export class StatementRangeDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be YYYY-MM' })
  period?: string;
}

@Controller('pdf')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PdfController {
  constructor(private readonly pdf: PdfService) {}

  /** Member savings statement, printable for the counter or the member's file. */
  @Get('members/:id/statement.pdf')
  @RequirePermissions('reports.view')
  async memberStatement(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) memberId: string,
    @Query() query: StatementRangeDto,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdf.memberStatement(
      principal.organizationId as string,
      memberId,
      query.from,
      query.to,
    );
    this.send(res, buffer, filename, 'inline');
  }

  @Get('loans/:id/statement.pdf')
  @RequirePermissions('reports.view')
  async loanStatement(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) loanId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdf.loanStatement(
      principal.organizationId as string,
      loanId,
    );
    this.send(res, buffer, filename, 'inline');
  }

  @Get('board-pack.pdf')
  @RequirePermissions('reports.view')
  async boardPack(
    @CurrentUser() principal: AuthPrincipal,
    @Query() query: StatementRangeDto,
    @Res() res: Response,
  ): Promise<void> {
    const period = query.period ?? new Date().toISOString().slice(0, 7);
    const { buffer, filename } = await this.pdf.boardPack(
      principal.organizationId as string,
      period,
    );
    this.send(res, buffer, filename, 'attachment');
  }

  @Get('receipts/:id.pdf')
  @RequirePermissions('reports.view')
  async receipt(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', new ParseUUIDPipe()) transactionId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdf.receipt(
      principal.organizationId as string,
      transactionId,
    );
    this.send(res, buffer, filename, 'inline');
  }

  private send(res: Response, buffer: Buffer, filename: string, disposition: 'inline' | 'attachment'): void {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }
}

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [PdfController],
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
