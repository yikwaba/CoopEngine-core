CREATE TABLE IF NOT EXISTS "member_savings_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"account_no" bigint NOT NULL,
	"current_balance" numeric(19, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_savings_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "savings_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"interest_rate_pa" numeric(7, 4) DEFAULT '0' NOT NULL,
	"min_deposit" numeric(19, 2) DEFAULT '0' NOT NULL,
	"allow_withdrawal" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "savings_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "savings_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"type" varchar(12) NOT NULL,
	"signed_amount" numeric(19, 2) NOT NULL,
	"running_balance" numeric(19, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "savings_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_counters" ADD COLUMN "savings_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_savings_accounts" ADD CONSTRAINT "member_savings_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_savings_accounts" ADD CONSTRAINT "member_savings_accounts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_savings_accounts" ADD CONSTRAINT "member_savings_accounts_product_id_savings_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."savings_products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_products" ADD CONSTRAINT "savings_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_transactions" ADD CONSTRAINT "savings_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_transactions" ADD CONSTRAINT "savings_transactions_account_id_member_savings_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."member_savings_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_transactions" ADD CONSTRAINT "savings_transactions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "savings_accounts_org_no_uq" ON "member_savings_accounts" USING btree ("organization_id","account_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "savings_accounts_member_product_uq" ON "member_savings_accounts" USING btree ("organization_id","member_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "savings_products_org_code_uq" ON "savings_products" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savings_txn_account_time_idx" ON "savings_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member_savings_accounts" AS PERMISSIVE FOR ALL TO public USING ("member_savings_accounts"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("member_savings_accounts"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "savings_products" AS PERMISSIVE FOR ALL TO public USING ("savings_products"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("savings_products"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "savings_transactions" AS PERMISSIVE FOR ALL TO public USING ("savings_transactions"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("savings_transactions"."organization_id" = current_setting('app.tenant_id', true)::uuid);