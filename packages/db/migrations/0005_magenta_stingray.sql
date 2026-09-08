CREATE TABLE IF NOT EXISTS "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"total_rows" bigint DEFAULT 0 NOT NULL,
	"valid_rows" bigint DEFAULT 0 NOT NULL,
	"invalid_rows" bigint DEFAULT 0 NOT NULL,
	"committed_count" bigint DEFAULT 0 NOT NULL,
	"rows" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_batches_org_status_idx" ON "import_batches" USING btree ("organization_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "import_batches" AS PERMISSIVE FOR ALL TO public USING ("import_batches"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("import_batches"."organization_id" = current_setting('app.tenant_id', true)::uuid);