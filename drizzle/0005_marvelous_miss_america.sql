ALTER TABLE "reconciliation_runs" ALTER COLUMN "outgoing_scan_status" SET DEFAULT 'not-run';--> statement-breakpoint
ALTER TABLE "treasuries" ADD COLUMN "last_outgoing_scan_block" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "treasuries" ADD COLUMN "last_outgoing_scan_at" timestamp with time zone;