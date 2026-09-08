import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';
import { parseCsv } from './csv';

export const MEMBER_CSV_HEADERS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'gender',
  'dateOfBirth',
] as const;

export type ImportedMemberData = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  gender?: string;
  dateOfBirth?: string;
};

export interface ImportPreviewRow {
  row: number;
  data?: ImportedMemberData;
  errors?: string[];
}

export interface ImportPreviewResult {
  batchId: string;
  filename: string;
  totals: {
    totalRows: number;
    valid: number;
    invalid: number;
  };
  errors: { row: number; reasons: string[] }[];
  sampleValid: ImportedMemberData[];
}

export interface ImportCommitResult {
  committed: number;
  batchStatus: string;
  memberNumbers: number[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s-]{7,20}$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = new Set(['MALE', 'FEMALE', 'OTHER']);

/** Normalize header names (case/space-insensitive). */
const normHeader = (h: string): string =>
  h.trim().toLowerCase().replace(/\s+/g, '');

function headerIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = normHeader(h);
    if (key) map.set(key, i);
  });
  return map;
}

function validateRowData(
  data: Record<string, string>,
): { value?: ImportedMemberData; errors: string[] } {
  const errors: string[] = [];
  const firstName = data.firstName?.trim() ?? '';
  const lastName = data.lastName?.trim() ?? '';
  if (!firstName) errors.push('firstName is required');
  if (!lastName) errors.push('lastName is required');

  const email = data.email?.trim().toLowerCase() || undefined;
  if (email && !EMAIL_RE.test(email)) {
    errors.push('email is not a valid email address');
  }
  const phone = data.phone?.trim() || undefined;
  if (phone && !PHONE_RE.test(phone)) {
    errors.push('phone is not a valid phone number');
  }
  const gender = data.gender?.trim().toUpperCase() || undefined;
  if (gender && !GENDERS.has(gender)) {
    errors.push('gender must be MALE, FEMALE or OTHER');
  }
  const dateOfBirth = data.dateOfBirth?.trim() || undefined;
  if (dateOfBirth && !DOB_RE.test(dateOfBirth)) {
    errors.push('dateOfBirth must be YYYY-MM-DD');
  }
  if (errors.length > 0) {
    return { value: undefined, errors };
  }
  return {
    value: { firstName, lastName, email, phone, gender, dateOfBirth },
    errors: [],
  };
}

@Injectable()
export class MemberImportService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }
    return organizationId;
  }

  /** Parse + validate an uploaded CSV and persist the preview batch. */
  async preview(
    organizationId: string | null,
    actorUserId: string,
    filename: string,
    csv: string,
  ): Promise<ImportPreviewResult> {
    const orgId = this.requireOrg(organizationId);
    if (!filename.trim()) throw new BadRequestException('filename is required');
    if (!csv || csv.trim().length === 0) {
      throw new BadRequestException('csv must not be empty');
    }
    if (csv.length > 2_000_000) {
      throw new BadRequestException('csv exceeds the 2 MB limit');
    }

    const parsed = parseCsv(csv);
    if (parsed.length < 2) {
      throw new BadRequestException(
        'CSV must contain a header row and at least one data row',
      );
    }
    const headerMap = headerIndex(parsed[0]!);
    const missing = MEMBER_CSV_HEADERS.filter((h) => !headerMap.has(normHeader(h)));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required columns: ${missing.join(', ')}`,
      );
    }

    const dataRows = parsed.slice(1);
    const previewRows: ImportPreviewRow[] = [];
    const seenEmails = new Map<string, number>(); // file-internal duplicates
    const emailList = new Set<string>();

    dataRows.forEach((cells, idx) => {
      const rowNo = idx + 2; // 1-based incl. header
      if (cells.every((c) => c.trim() === '')) return; // blank line
      const record: Record<string, string> = {};
      for (const h of MEMBER_CSV_HEADERS) {
        const i = headerMap.get(normHeader(h));
        record[h] = i !== undefined && i < cells.length ? (cells[i] ?? '') : '';
      }
      const { value, errors } = validateRowData(record);
      const reasons = [...errors];

      const email = value?.email;
      if (email) {
        emailList.add(email);
        if (seenEmails.has(email)) {
          reasons.push(`duplicate email in file (row ${seenEmails.get(email)})`);
        } else {
          seenEmails.set(email, rowNo);
        }
      }
      if (reasons.length > 0) {
        previewRows.push({ row: rowNo, errors: reasons });
      } else {
        previewRows.push({ row: rowNo, data: value });
      }
    });

    // Cross-check against existing members in this tenant (RLS-scoped read).
    const existing = await this.findExistingEmails(orgId, [...emailList]);

    const finalRows: ImportPreviewRow[] = [];
    for (const r of previewRows) {
      if (r.data?.email && existing.has(r.data.email)) {
        finalRows.push({
          row: r.row,
          errors: ['email is already a member of this cooperative'],
        });
      } else {
        finalRows.push(r);
      }
    }

    const valid = finalRows.filter((r) => r.data && r.errors === undefined);
    const invalid = finalRows.filter((r) => r.errors !== undefined);
    const batchId = randomUUID();

    await withTenant(this.pool, orgId, async (c) => {
      await c.query(
        `INSERT INTO import_batches
           (id, organization_id, filename, status, total_rows, valid_rows, invalid_rows, rows, created_by)
         VALUES ($1, $2, $3, 'PREVIEWED', $4, $5, $6, $7::jsonb, $8)`,
        [
          batchId,
          orgId,
          filename.trim(),
          finalRows.length,
          valid.length,
          invalid.length,
          JSON.stringify(finalRows),
          actorUserId,
        ],
      );
    });

    return {
      batchId,
      filename: filename.trim(),
      totals: {
        totalRows: finalRows.length,
        valid: valid.length,
        invalid: invalid.length,
      },
      errors: invalid.map((r) => ({
        row: r.row,
        reasons: r.errors ?? [],
      })),
      sampleValid: valid.slice(0, 5).map((r) => r.data as ImportedMemberData),
    };
  }

  /** Commit a previewed batch: create members atomically in one tenant tx. */
  async commit(
    organizationId: string | null,
    actorUserId: string,
    batchId: string,
  ): Promise<ImportCommitResult> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const batch = await c.query(
        `SELECT id, status, rows FROM import_batches
          WHERE organization_id = $1 AND id = $2`,
        [orgId, batchId],
      );
      const b = batch.rows[0] as
        | { id: string; status: string; rows: unknown }
        | undefined;
      if (!b) throw new NotFoundException('Import batch not found');
      if (b.status === 'COMMITTED') {
        throw new ConflictException('Import batch already committed');
      }
      if (b.status !== 'PREVIEWED') {
        throw new ConflictException(`Import batch is in state ${b.status}`);
      }

      const rows = b.rows as ImportPreviewRow[];
      const validRows = rows.filter(
        (r): r is ImportPreviewRow & { data: ImportedMemberData } =>
          r.data !== undefined && r.errors === undefined,
      );

      const created: { id: string; memberNo: number }[] = [];
      for (const row of validRows) {
        const seq = await c.query(
          `UPDATE org_counters SET member_seq = member_seq + 1, updated_at = now()
            WHERE organization_id = $1 RETURNING member_seq`,
          [orgId],
        );
        const memberNo = Number(
          (seq.rows[0] as { member_seq: string | number }).member_seq,
        );
        const ins = await c.query(
          `INSERT INTO members (organization_id, member_no, first_name, last_name,
                                email, phone, gender, date_of_birth, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
           RETURNING id, member_no`,
          [
            orgId,
            memberNo,
            row.data.firstName,
            row.data.lastName,
            row.data.email ?? null,
            row.data.phone ?? null,
            row.data.gender ?? null,
            row.data.dateOfBirth ?? null,
            actorUserId,
          ],
        );
        created.push({
          id: (ins.rows[0] as { id: string }).id,
          memberNo: Number((ins.rows[0] as { member_no: string | number }).member_no),
        });
      }

      await c.query(
        `UPDATE import_batches
            SET status = 'COMMITTED', committed_count = $1, committed_at = now()
          WHERE organization_id = $2 AND id = $3`,
        [created.length, orgId, batchId],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'member.import.committed', 'import_batch', $3, $4)`,
        [
          orgId,
          actorUserId,
          batchId,
          JSON.stringify({ committed: created.length, total: validRows.length }),
        ],
      );

      return {
        committed: created.length,
        batchStatus: 'COMMITTED',
        memberNumbers: created.map((x) => x.memberNo),
      };
    });
  }

  private async findExistingEmails(
    orgId: string,
    emails: string[],
  ): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `SELECT lower(email) AS email FROM members
          WHERE organization_id = $1 AND lower(email) = ANY($2::varchar[])`,
        [orgId, emails.map((e) => e.toLowerCase())],
      );
      return new Set(rows.map((r: { email: string }) => r.email));
    });
  }
}
