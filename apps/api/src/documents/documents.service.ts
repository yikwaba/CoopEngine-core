import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { withTenant } from '@coopengine/db';
import { DB_POOL } from '../database/database.module';

export const DOC_TYPES = ['ID_CARD', 'UTILITY_BILL', 'PASSPORT', 'SIGNATURE', 'OTHER'] as const;
const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];
const MAX_BYTES = Number(process.env.DOCUMENTS_MAX_BYTES ?? 5 * 1024 * 1024);

export interface DocumentRow {
  id: string;
  memberId: string;
  docType: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  uploadedByMember: boolean;
  reviewNotes: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/**
 * KYC document vault. Files live on disk under DOCUMENTS_DIR (default
 * /root/coopengine/uploads) in per-tenant folders; the database keeps the
 * metadata and review state, and all reads/writes go through the RLS-scoped
 * tenant transaction first, so one tenant can never touch another's files.
 */
@Injectable()
export class DocumentsService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private get rootDir(): string {
    return process.env.DOCUMENTS_DIR ?? '/root/coopengine/uploads';
  }

  private requireOrg(organizationId: string | null): string {
    if (!organizationId) throw new ConflictException('No organization in context');
    return organizationId;
  }

  private map(r: Record<string, unknown>): DocumentRow {
    return {
      id: r.id as string,
      memberId: r.member_id as string,
      docType: r.doc_type as string,
      fileName: r.file_name as string,
      mimeType: r.mime_type as string,
      sizeBytes: Number(r.size_bytes),
      status: r.status as string,
      uploadedByMember: Boolean(r.uploaded_by_member),
      reviewNotes: (r.review_notes as string | null) ?? null,
      reviewedAt: (r.reviewed_at as Date | null) ?? null,
      createdAt: r.created_at as Date,
    };
  }

  async upload(
    organizationId: string | null,
    memberId: string,
    input: { docType: string; fileName: string; mimeType: string; contentBase64: string },
    options: { byMember?: boolean } = {},
  ): Promise<DocumentRow> {
    const orgId = this.requireOrg(organizationId);
    if (!DOC_TYPES.includes(input.docType as (typeof DOC_TYPES)[number])) {
      throw new BadRequestException(`docType must be one of ${DOC_TYPES.join(', ')}`);
    }
    if (!ALLOWED_MIME.includes(input.mimeType)) {
      throw new BadRequestException('Only JPEG, PNG, WEBP or PDF documents are accepted');
    }
    const buffer = Buffer.from(input.contentBase64 ?? '', 'base64');
    if (buffer.length === 0) throw new BadRequestException('Document content is empty');
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException(`Document exceeds the ${MAX_BYTES} byte limit`);
    }

    return withTenant(this.pool, orgId, async (c) => {
      const member = await c.query(`SELECT id FROM members WHERE id = $1`, [memberId]);
      if (!member.rows[0]) throw new NotFoundException('Member not found');

      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'document';
      const id = randomUUID();
      const relative = join(orgId, memberId, `${id}-${safeName}`);
      const absolute = join(this.rootDir, relative);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, buffer);

      const { rows } = await c.query(
        `INSERT INTO member_documents
           (id, organization_id, member_id, doc_type, file_name, mime_type, size_bytes,
            storage_path, status, uploaded_by_member)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
         RETURNING *`,
        [
          id,
          orgId,
          memberId,
          input.docType,
          safeName,
          input.mimeType,
          buffer.length,
          relative,
          options.byMember ?? false,
        ],
      );
      await c.query(
        `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'document.uploaded', 'member_document', $2, $3)`,
        [orgId, id, JSON.stringify({ memberId, docType: input.docType, bytes: buffer.length })],
      );
      return this.map(rows[0] as Record<string, unknown>);
    });
  }

  async list(
    organizationId: string | null,
    filters: { memberId?: string; status?: string } = {},
  ): Promise<DocumentRow[]> {
    const orgId = this.requireOrg(organizationId);
    return withTenant(this.pool, orgId, async (c) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters.memberId) {
        params.push(filters.memberId);
        where.push(`member_id = $${params.length}`);
      }
      if (filters.status) {
        params.push(filters.status);
        where.push(`status = $${params.length}`);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await c.query(
        `SELECT * FROM member_documents ${clause} ORDER BY created_at DESC LIMIT 500`,
        params,
      );
      return rows.map((r) => this.map(r as Record<string, unknown>));
    });
  }

  /** Read a document's bytes after the tenant check (RLS decides visibility). */
  async read(
    organizationId: string | null,
    documentId: string,
  ): Promise<{ row: DocumentRow; content: Buffer }> {
    const orgId = this.requireOrg(organizationId);
    const row = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(`SELECT * FROM member_documents WHERE id = $1`, [documentId]);
      const r = rows[0] as Record<string, unknown> | undefined;
      if (!r) throw new NotFoundException('Document not found');
      return this.map(r);
    });
    const meta = await withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(`SELECT storage_path FROM member_documents WHERE id = $1`, [
        documentId,
      ]);
      return (rows[0] as { storage_path: string }).storage_path;
    });
    if (meta.includes('..')) throw new ForbiddenException('Invalid document path');
    const content = await readFile(join(this.rootDir, meta));
    return { row, content };
  }

  async review(
    organizationId: string | null,
    actorUserId: string,
    documentId: string,
    status: 'VERIFIED' | 'REJECTED',
    notes?: string,
  ): Promise<DocumentRow> {
    const orgId = this.requireOrg(organizationId);
    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('status must be VERIFIED or REJECTED');
    }
    return withTenant(this.pool, orgId, async (c) => {
      const { rows } = await c.query(
        `UPDATE member_documents
            SET status = $2, review_notes = $3, reviewer_user_id = $4, reviewed_at = now()
          WHERE id = $1
        RETURNING *`,
        [documentId, status, notes ?? null, actorUserId],
      );
      const r = rows[0] as Record<string, unknown> | undefined;
      if (!r) throw new NotFoundException('Document not found');
      await c.query(
        `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, $3, 'member_document', $4, $5)`,
        [
          orgId,
          actorUserId,
          status === 'VERIFIED' ? 'document.verified' : 'document.rejected',
          documentId,
          JSON.stringify({ notes: notes ?? null }),
        ],
      );
      return this.map(r);
    });
  }
}
