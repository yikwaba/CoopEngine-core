CREATE TABLE IF NOT EXISTS "member_virtual_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"provider" varchar(16) DEFAULT 'dev' NOT NULL,
	"account_reference" varchar(80) NOT NULL,
	"account_number" varchar(32) NOT NULL,
	"account_name" varchar(160) NOT NULL,
	"bank_name" varchar(120) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_virtual_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"account_reference" varchar(80) NOT NULL,
	"account_number" varchar(32) NOT NULL,
	"payment_reference" varchar(120) NOT NULL,
	"transaction_reference" varchar(120) NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"journal_entry_id" uuid,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_virtual_accounts" ADD CONSTRAINT "member_virtual_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_virtual_accounts" ADD CONSTRAINT "member_virtual_accounts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "virtual_accounts_number_uq" ON "member_virtual_accounts" USING btree ("organization_id","account_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "virtual_accounts_member_idx" ON "member_virtual_accounts" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_notifications_ref_uq" ON "payment_notifications" USING btree ("organization_id","payment_reference");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member_virtual_accounts" AS PERMISSIVE FOR ALL TO public USING ("member_virtual_accounts"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("member_virtual_accounts"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_notifications" AS PERMISSIVE FOR ALL TO public USING ("payment_notifications"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("payment_notifications"."organization_id" = current_setting('app.tenant_id', true)::uuid);