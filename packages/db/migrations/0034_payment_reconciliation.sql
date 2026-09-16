CREATE TABLE IF NOT EXISTS "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"purpose" text DEFAULT 'SAVINGS_DEPOSIT' NOT NULL,
	"reference" varchar(64) NOT NULL,
	"expected_amount" numeric(19, 2) NOT NULL,
	"received_amount" numeric(19, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"due_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'MANUAL' NOT NULL,
	"provider_reference" varchar(128) NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"payer_name" varchar(255),
	"payer_account" varchar(64),
	"narration" text,
	"virtual_account_no" varchar(32),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'UNMATCHED' NOT NULL,
	"exception_reason" text,
	"member_id" uuid,
	"payment_intent_id" uuid,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intents_org_ref_uq" ON "payment_intents" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_org_status_idx" ON "payment_intents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_transactions_ref_uq" ON "provider_transactions" USING btree ("organization_id","provider","provider_reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_transactions_org_status_idx" ON "provider_transactions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_intents" AS PERMISSIVE FOR ALL TO public USING ("payment_intents"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("payment_intents"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "provider_transactions" AS PERMISSIVE FOR ALL TO public USING ("provider_transactions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("provider_transactions"."organization_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "internal_scan" ON "provider_transactions" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.internal_scan', true), '') = 'on');
-- Money received but not yet allocated to a member needs somewhere to sit. Without this
-- account an unmatched receipt has no legal double entry, so the alternative was to leave the
-- cash unposted or to invent a member to hang it on. Both are worse than a suspense liability.
--
-- New cooperatives get it from DEFAULT_CHART_OF_ACCOUNTS; this adds it to the ones that already
-- exist. Every tenant-owned table is row-level secured, so the insert is scoped to each
-- organisation in turn (setting app.tenant_id), exactly as the application does.
DO $$
DECLARE
  org record;
BEGIN
  -- organisations is row-level secured too: without the scan policy this loop sees nothing
  PERFORM set_config('app.internal_scan', 'on', true);
  FOR org IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.tenant_id', org.id::text, true);
    INSERT INTO chart_of_accounts (id, organization_id, code, name, type, category, is_system)
    SELECT gen_random_uuid(), org.id, '2990', 'Unallocated Receipts', 'LIABILITY', 'Member Funds', true
     WHERE NOT EXISTS (
       SELECT 1 FROM chart_of_accounts a
        WHERE a.organization_id = org.id AND a.code = '2990'
     );
  END LOOP;
END $$;
