CREATE TYPE "public"."email_delivery_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"recipients" text[] NOT NULL,
	"subject" text NOT NULL,
	"status" "email_delivery_status" NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"error_summary" text,
	"related_entity_type" text,
	"related_entity_id" text,
	"correlation_id" text,
	"service_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_deliveries_sent_at_idx" ON "email_deliveries" USING btree ("sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_deliveries_related_entity_idx" ON "email_deliveries" USING btree ("related_entity_type","related_entity_id");