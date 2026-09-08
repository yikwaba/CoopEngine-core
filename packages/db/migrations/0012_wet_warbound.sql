CREATE TABLE IF NOT EXISTS "member_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_otps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_lookups" (
	"slug" varchar(80) PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "org_lookups_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_otps" ADD CONSTRAINT "member_otps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_otps" ADD CONSTRAINT "member_otps_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_otps_member_created_idx" ON "member_otps" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member_otps" AS PERMISSIVE FOR ALL TO public USING ("member_otps"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("member_otps"."organization_id" = current_setting('app.tenant_id', true)::uuid);