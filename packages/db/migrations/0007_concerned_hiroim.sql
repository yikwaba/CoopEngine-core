DROP INDEX IF EXISTS "journal_entries_org_no_uq";--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "entry_no" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_org_no_uq" ON "journal_entries" USING btree ("organization_id","entry_no") WHERE "journal_entries"."entry_no" IS NOT NULL;