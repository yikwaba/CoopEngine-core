CREATE TABLE IF NOT EXISTS "loan_guarantors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"loan_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_guarantors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loan_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"interest_rate_pa" numeric(7, 4) DEFAULT '0' NOT NULL,
	"interest_method" varchar(16) DEFAULT 'FLAT' NOT NULL,
	"multiplier" numeric(5, 2) DEFAULT '3' NOT NULL,
	"min_principal" numeric(19, 2) DEFAULT '0' NOT NULL,
	"max_principal" numeric(19, 2),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loan_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"loan_product_id" uuid NOT NULL,
	"principal" numeric(19, 2) NOT NULL,
	"term_months" bigint NOT NULL,
	"interest_rate_pa" numeric(7, 4) NOT NULL,
	"interest_method" varchar(16) DEFAULT 'FLAT' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"outstanding_principal" numeric(19, 2) DEFAULT '0' NOT NULL,
	"rejection_reason" varchar(255),
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"disbursed_by" uuid,
	"disbursed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_guarantors" ADD CONSTRAINT "loan_guarantors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_guarantors" ADD CONSTRAINT "loan_guarantors_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_guarantors" ADD CONSTRAINT "loan_guarantors_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loan_products" ADD CONSTRAINT "loan_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_loan_product_id_loan_products_id_fk" FOREIGN KEY ("loan_product_id") REFERENCES "public"."loan_products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "loans" ADD CONSTRAINT "loans_disbursed_by_users_id_fk" FOREIGN KEY ("disbursed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loan_guarantors_uq" ON "loan_guarantors" USING btree ("loan_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loan_products_org_code_uq" ON "loan_products" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loans_org_status_idx" ON "loans" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loans_org_member_idx" ON "loans" USING btree ("organization_id","member_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "loan_guarantors" AS PERMISSIVE FOR ALL TO public USING ("loan_guarantors"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("loan_guarantors"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "loan_products" AS PERMISSIVE FOR ALL TO public USING ("loan_products"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("loan_products"."organization_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "loans" AS PERMISSIVE FOR ALL TO public USING ("loans"."organization_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("loans"."organization_id" = current_setting('app.tenant_id', true)::uuid);