CREATE TABLE IF NOT EXISTS "payroll_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"total_rows" bigint DEFAULT 0 NOT NULL,
	"valid_rows" bigint DEFAULT 0 NOT NULL,
	"invalid_count" bigint DEFAULT 0 NOT NULL,
	"rows" jsonb,
	"total_amount" numeric(19, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid,
	"committed_by" uuid,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payroll_batches" AS PERMISSIVE FOR ALL TO public USING ("payroll_batches"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("payroll_batches"."organization_id" = current_setting('app.tenant_id', true)::uuid);