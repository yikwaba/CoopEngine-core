CREATE TABLE IF NOT EXISTS "loan_repayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"due_date" date NOT NULL,
	"principal_due" numeric(19, 2) NOT NULL,
	"interest_due" numeric(19, 2) NOT NULL,
	"paid_principal" numeric(19, 2) DEFAULT '0' NOT NULL,
	"paid_interest" numeric(19, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_repayments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_share_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"current_balance" numeric(19, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_share_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"type" varchar(16) DEFAULT 'PURCHASE' NOT NULL,
	"signed_amount" numeric(19, 2) NOT NULL,
	"running_balance" numeric(19, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_share_accounts" ADD CONSTRAINT "member_share_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_share_accounts" ADD CONSTRAINT "member_share_accounts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "share_transactions" ADD CONSTRAINT "share_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "share_transactions" ADD CONSTRAINT "share_transactions_account_id_member_share_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."member_share_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "share_transactions" ADD CONSTRAINT "share_transactions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loan_repayments_loan_seq_uq" ON "loan_repayments" USING btree ("loan_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_share_accounts_org_member_uq" ON "member_share_accounts" USING btree ("organization_id","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_txn_account_time_idx" ON "share_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "loan_repayments" AS PERMISSIVE FOR ALL TO public USING ("loan_repayments"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("loan_repayments"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member_share_accounts" AS PERMISSIVE FOR ALL TO public USING ("member_share_accounts"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("member_share_accounts"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "share_transactions" AS PERMISSIVE FOR ALL TO public USING ("share_transactions"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("share_transactions"."organization_id" = current_setting('app.tenant_id', true)::uuid);