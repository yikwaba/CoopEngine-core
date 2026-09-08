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
  bigint,
  boolean,
  date,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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

/** Per-tenant running counters (e.g. member_no) — row-locked increments. */
export const orgCounters = pgTable(
  'org_counters',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberSeq: bigint('member_seq', { mode: 'number' })
      .notNull()
      .default(0),
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

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberNo: bigint('member_no', { mode: 'number' }).notNull(),
    firstName: varchar('first_name', { length: 120 }).notNull(),
    lastName: varchar('last_name', { length: 120 }).notNull(),
    email: varchar('email', { length: 320 }),
    phone: varchar('phone', { length: 32 }),
    gender: varchar('gender', { length: 16 }),
    dateOfBirth: date('date_of_birth'),
    status: text('status').notNull().default('PENDING'),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
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
    index('members_org_status_idx').on(table.organizationId, table.status),
    uniqueIndex('members_org_member_no_uq').on(
      table.organizationId,
      table.memberNo,
    ),
  ],
);

export const nextOfKin = pgTable(
  'next_of_kin',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    relationship: varchar('relationship', { length: 64 }),
    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 320 }),
    address: text('address'),
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
    index('next_of_kin_org_member_idx').on(
      table.organizationId,
      table.memberId,
    ),
  ],
);

/** Bulk member-import batches: validated preview rows awaiting commit. */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    status: text('status').notNull().default('PENDING'),
    totalRows: bigint('total_rows', { mode: 'number' }).notNull().default(0),
    validRows: bigint('valid_rows', { mode: 'number' }).notNull().default(0),
    invalidRows: bigint('invalid_rows', { mode: 'number' })
      .notNull()
      .default(0),
    committedCount: bigint('committed_count', { mode: 'number' })
      .notNull()
      .default(0),
    rows: jsonb('rows').notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (table) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      using: tenantScope(table.organizationId),
      withCheck: tenantScope(table.organizationId),
    }),
    index('import_batches_org_status_idx').on(
      table.organizationId,
      table.status,
    ),
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
  mfaSecret: text('mfa_secret'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Login attempt tracking for rate limiting (email + IP windows). */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    ipAddress: text('ip_address').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('login_attempts_email_ip_time_idx').on(
      table.email,
      table.ipAddress,
      table.attemptedAt,
    ),
  ],
);

/**
 * Roles (org-scoped by default; `scope='saas'` roles are platform-global).
 * Role rows are NOT RLS-protected in this phase: they are read by the auth
 * service outside any tenant context (login/org listing) and guarded at the
 * application layer. Membership data remains the RLS-protected surface.
 */
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  scope: text('scope').notNull().default('org'),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 100 }).notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(
      () => organizations.id,
      { onDelete: 'cascade' },
    ),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('user_roles_user_org_idx').on(
      table.userId,
      table.organizationId,
    ),
  ],
);

/** Refresh-token sessions (rotating, revocable). */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
  ],
);

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
export type OrgCounter = typeof orgCounters.$inferSelect;
export type NewOrgCounter = typeof orgCounters.$inferInsert;
export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type NextOfKin = typeof nextOfKin.$inferSelect;
export type NewNextOfKin = typeof nextOfKin.$inferInsert;
export type ImportBatch = typeof importBatches.$inferSelect;
export type NewImportBatch = typeof importBatches.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type NewLoginAttempt = typeof loginAttempts.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
