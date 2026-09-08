/**
 * Co-opEngine database schema (Drizzle ORM, PostgreSQL).
 *
 * Conventions (Technical Implementation Plan §3):
 * - Every table: `id uuid PK DEFAULT gen_random_uuid()`, created_at/updated_at.
 * - Every tenant-owned table carries `organization_id` and is RLS-protected.
 * - Money is NUMERIC(19,2) — never float.
 *
 * Phase 0 baseline: tenancy + identity seeds only. Expanded in Phase 1 sprints.
 */

import {
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
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
});

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

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
