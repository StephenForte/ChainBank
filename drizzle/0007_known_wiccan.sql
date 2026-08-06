ALTER TABLE "alerts" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "acknowledgement_note" text;