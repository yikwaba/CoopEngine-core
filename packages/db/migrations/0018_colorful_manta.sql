CREATE TABLE IF NOT EXISTS "dividend_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"share_balance" numeric(19, 2) NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dividend_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dividend_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_label" varchar(16) NOT NULL,
	"distributable_amount" numeric(19, 2) NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"journal_entry_id" uuid,
	"member_count" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dividend_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dividend_allocations" ADD CONSTRAINT "dividend_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dividend_allocations" ADD CONSTRAINT "dividend_allocations_run_id_dividend_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."dividend_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dividend_allocations" ADD CONSTRAINT "dividend_allocations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dividend_runs" ADD CONSTRAINT "dividend_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dividend_runs" ADD CONSTRAINT "dividend_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dividend_allocations" AS PERMISSIVE FOR ALL TO public USING ("dividend_allocations"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("dividend_allocations"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dividend_runs" AS PERMISSIVE FOR ALL TO public USING ("dividend_runs"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("dividend_runs"."organization_id" = current_setting('app.tenant_id', true)::uuid);