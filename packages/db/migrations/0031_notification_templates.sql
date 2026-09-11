CREATE TABLE IF NOT EXISTS "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"channel" varchar(8) DEFAULT 'ANY' NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_templates_org_code_uq" ON "notification_templates" USING btree ("organization_id","code");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notification_templates" AS PERMISSIVE FOR ALL TO public USING ("notification_templates"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("notification_templates"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);