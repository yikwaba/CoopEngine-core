/**
 * Co-opEngine database schema (Drizzle ORM, PostgreSQL).
 *
 * Conventions (Technical Implementation Plan §3–§4):
 * - Every table: `id uuid PK DEFAULT gen_random_uuid()`, created_at/updated_at.
 * - Every tenant-owned table carries `organization_id` and is RLS-protected.
 * - Money is NUMERIC(19,2) — never float.
 * - RLS policy shape: `tenant_isolation` using the transaction-local GUC
 *   `app.tenant_id` (defense in depth — see ADR-0003).
 *
 * Phase 1A baseline: tenancy (organizations, settings, branches), audit_logs.
 */

import {
  boolean,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Transaction-local tenant GUC set by the app for every tenant-scoped request. */
export const TENANT_GUC = 'app.tenant_id';

/** Policy predicate: row belongs to the current tenant context. */
const tenantScope = (orgColumn: unknown) =>
  sql`${orgColumn} = current_setting('app.tenant_id', true)::uuid`;

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    legalName: varchar('legal_name', { length: 255 }),
    slug: varchar('slug', { length: 80 }).notNull().unique(),
    subdomain: varchar('subdomain', { length: 80 }).unique(),
    status: text('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_self_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.id),
      withCheck: tenantScope(table.id),
    }),
  ],
);

export const organizationSettings = pgTable(
  'organization_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    timezone: varchar('timezone', { length: 64 })
      .notNull()
      .default('Africa/Lagos'),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 32 }),
    isHeadquarters: boolean('is_headquarters').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('branches_org_idx').on(table.organizationId),
  ],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  passwordHash: text('password_hash'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Central audit log — deliberately NOT RLS-protected at DB level:
 * writes must never be blocked (system-level events have no tenant GUC),
 * and reads are guarded at the application layer (audit.view permission,
 * org scope in queries). See Technical Implementation Plan §13.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    actorUserId: uuid('actor_user_id'),
    action: varchar('action', { length: 120 }).notNull(),
    entityType: varchar('entity_type', { length: 80 }),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'),
    sessionId: text('session_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_logs_org_created_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    index('audit_logs_action_idx').on(table.action),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationSettings = typeof organizationSettings.$inferSelect;
export type NewOrganizationSettings = typeof organizationSettings.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
