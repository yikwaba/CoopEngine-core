CREATE TABLE IF NOT EXISTS "opening_balance_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" varchar(120) NOT NULL,
	"source_filename" varchar(255),
	"status" text DEFAULT 'PENDING' NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"savings_total" numeric(19, 2) DEFAULT '0' NOT NULL,
	"shares_total" numeric(19, 2) DEFAULT '0' NOT NULL,
	"loans_total" numeric(19, 2) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "opening_balance_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "opening_balance_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"savings_amount" numeric(19, 2) DEFAULT '0' NOT NULL,
	"shares_amount" numeric(19, 2) DEFAULT '0' NOT NULL,
	"loan_outstanding" numeric(19, 2) DEFAULT '0' NOT NULL,
	"loan_term_months" integer,
	"loan_rate_pa" numeric(9, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_balance_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opening_balance_rows" ADD CONSTRAINT "opening_balance_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opening_balance_rows" ADD CONSTRAINT "opening_balance_rows_batch_id_opening_balance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."opening_balance_batches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opening_balance_rows" ADD CONSTRAINT "opening_balance_rows_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "opening_balance_batches" AS PERMISSIVE FOR ALL TO public USING ("opening_balance_batches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("opening_balance_batches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "opening_balance_rows" AS PERMISSIVE FOR ALL TO public USING ("opening_balance_rows"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("opening_balance_rows"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "branches" TO public USING ("branches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("branches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "chart_of_accounts" TO public USING ("chart_of_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("chart_of_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "dividend_allocations" TO public USING ("dividend_allocations"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dividend_allocations"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "dividend_runs" TO public USING ("dividend_runs"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("dividend_runs"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "import_batches" TO public USING ("import_batches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("import_batches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "journal_entries" TO public USING ("journal_entries"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("journal_entries"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "journal_lines" TO public USING ("journal_lines"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("journal_lines"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "ledger_periods" TO public USING ("ledger_periods"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("ledger_periods"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "loan_guarantors" TO public USING ("loan_guarantors"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("loan_guarantors"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "loan_products" TO public USING ("loan_products"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("loan_products"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "loan_repayments" TO public USING ("loan_repayments"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("loan_repayments"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "loans" TO public USING ("loans"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("loans"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "member_documents" TO public USING ("member_documents"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("member_documents"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "member_otps" TO public USING ("member_otps"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("member_otps"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "member_savings_accounts" TO public USING ("member_savings_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("member_savings_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "member_share_accounts" TO public USING ("member_share_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("member_share_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "member_virtual_accounts" TO public USING ("member_virtual_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("member_virtual_accounts"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "members" TO public USING ("members"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("members"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "next_of_kin" TO public USING ("next_of_kin"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("next_of_kin"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "notifications" TO public USING ("notifications"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("notifications"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "org_counters" TO public USING ("org_counters"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("org_counters"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "organization_settings" TO public USING ("organization_settings"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("organization_settings"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_self_isolation" ON "organizations" TO public USING ("organizations"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("organizations"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "payment_notifications" TO public USING ("payment_notifications"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("payment_notifications"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "payroll_batches" TO public USING ("payroll_batches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("payroll_batches"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "savings_goals" TO public USING ("savings_goals"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("savings_goals"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "savings_interest_postings" TO public USING ("savings_interest_postings"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("savings_interest_postings"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "savings_products" TO public USING ("savings_products"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("savings_products"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "savings_transactions" TO public USING ("savings_transactions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("savings_transactions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "share_transactions" TO public USING ("share_transactions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("share_transactions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "standing_instructions" TO public USING ("standing_instructions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("standing_instructions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);