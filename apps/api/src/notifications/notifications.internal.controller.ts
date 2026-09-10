import {
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { NotificationsService } from './notifications.service';

class InternalDispatchDto {
  @IsOptional()
  @IsString()
  organizationId?: string;
}

/**
 * Machine-to-machine dispatch used by the nightly timer. Guarded by the shared
 * INTERNAL_CRON_TOKEN (root-only api.env) instead of a user session.
 */
@Controller('internal/notifications')
export class NotificationsInternalController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Post('dispatch')
  async dispatch(
    @Headers('x-internal-token') token: string | undefined,
    @Body() dto: InternalDispatchDto,
  ) {
    const expected = process.env.INTERNAL_CRON_TOKEN ?? '';
    if (!expected || token !== expected) {
      throw new UnauthorizedException('Invalid internal token');
    }
    const orgIds: string[] = [];
    if (dto.organizationId) {
      orgIds.push(dto.organizationId);
    } else {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.internal_scan', 'on', true)`);
        const { rows } = await client.query(`SELECT id FROM organizations ORDER BY created_at`);
        for (const r of rows as { id: string }[]) orgIds.push(r.id);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    let attempted = 0;
    let sent = 0;
    let failed = 0;
    for (const orgId of orgIds) {
      const result = await this.notificationsService.dispatchPending(orgId, null, {});
      attempted += result.attempted;
      sent += result.sent;
      failed += result.failed;
    }
    return { organizations: orgIds.length, attempted, sent, failed };
  }
}
