CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_no" bigint NOT NULL,
	"first_name" varchar(120) NOT NULL,
	"last_name" varchar(120) NOT NULL,
	"email" varchar(320),
	"phone" varchar(32),
	"gender" varchar(16),
	"date_of_birth" date,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"joined_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "next_of_kin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"relationship" varchar(64),
	"phone" varchar(32),
	"email" varchar(320),
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "next_of_kin" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_counters" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"member_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "members" ADD CONSTRAINT "members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "next_of_kin" ADD CONSTRAINT "next_of_kin_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "next_of_kin" ADD CONSTRAINT "next_of_kin_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_counters" ADD CONSTRAINT "org_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_org_status_idx" ON "members" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_org_member_no_uq" ON "members" USING btree ("organization_id","member_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "next_of_kin_org_member_idx" ON "next_of_kin" USING btree ("organization_id","member_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "members" AS PERMISSIVE FOR ALL TO public USING ("members"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("members"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "next_of_kin" AS PERMISSIVE FOR ALL TO public USING ("next_of_kin"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("next_of_kin"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org_counters" AS PERMISSIVE FOR ALL TO public USING ("org_counters"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("org_counters"."organization_id" = current_setting('app.tenant_id', true)::uuid);
-- backfill org_counters for existing organizations
INSERT INTO org_counters (organization_id, member_seq)
SELECT id, 0 FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM org_counters c WHERE c.organization_id = o.id);
