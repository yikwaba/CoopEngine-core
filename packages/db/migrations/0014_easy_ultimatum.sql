CREATE TABLE IF NOT EXISTS "savings_interest_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_code" varchar(7) NOT NULL,
	"total_amount" numeric(19, 2) DEFAULT '0' NOT NULL,
	"entry_id" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "savings_interest_postings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_interest_postings" ADD CONSTRAINT "savings_interest_postings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_interest_postings" ADD CONSTRAINT "savings_interest_postings_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_interest_postings" ADD CONSTRAINT "savings_interest_postings_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "interest_postings_org_period_uq" ON "savings_interest_postings" USING btree ("organization_id","period_code");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "savings_interest_postings" AS PERMISSIVE FOR ALL TO public USING ("savings_interest_postings"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("savings_interest_postings"."organization_id" = current_setting('app.tenant_id', true)::uuid);