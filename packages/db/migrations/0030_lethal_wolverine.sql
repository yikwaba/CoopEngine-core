ALTER TABLE "opening_balance_rows" ADD COLUMN "loan_paid_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opening_balance_rows" ADD COLUMN "loan_principal" numeric(19, 2);--> statement-breakpoint
ALTER TABLE "opening_balance_rows" ADD COLUMN "loan_last_payment_date" date;