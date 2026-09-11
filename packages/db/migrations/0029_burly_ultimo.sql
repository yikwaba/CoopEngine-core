CREATE TABLE IF NOT EXISTS "savings_withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"description" varchar(240),
	"status" text DEFAULT 'PENDING' NOT NULL,
	"source" text DEFAULT 'STAFF' NOT NULL,
	"requested_by_user_id" uuid,
	"requested_by_member_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_notes" varchar(240),
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "savings_withdrawal_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "withdrawal_approval_threshold" numeric(19, 2);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_account_id_member_savings_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."member_savings_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_requested_by_member_id_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_withdrawal_requests" ADD CONSTRAINT "savings_withdrawal_requests_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "savings_withdrawal_requests" AS PERMISSIVE FOR ALL TO public USING ("savings_withdrawal_requests"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("savings_withdrawal_requests"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);