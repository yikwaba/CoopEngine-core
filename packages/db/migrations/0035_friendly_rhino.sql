ALTER TABLE "payroll_batches" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "reversed_by" uuid;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "payroll_batches" ADD COLUMN "journal_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payroll_batches" ADD CONSTRAINT "payroll_batches_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
