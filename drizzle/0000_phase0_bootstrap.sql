CREATE TYPE "public"."actor_type" AS ENUM('api_credential', 'cron', 'system');--> statement-breakpoint
CREATE TYPE "public"."api_role" AS ENUM('operator', 'project-service', 'read-only', 'cron-treasury-monitor', 'cron-reconciler');--> statement-breakpoint
CREATE TYPE "public"."treasury_status" AS ENUM('healthy', 'warning', 'critical', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."wallet_type" AS ENUM('treasury', 'managed_wallet');--> statement-breakpoint
CREATE TABLE "api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" "api_role" NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"request_id" text,
	"source_ip" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"wallet_type" "wallet_type" NOT NULL,
	"balance_wei" numeric(78, 0) NOT NULL,
	"block_number" numeric(78, 0) NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source_operation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"chain_id" integer NOT NULL,
	"display_name" text NOT NULL,
	"native_symbol" text NOT NULL,
	"explorer_base_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"service_role" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_operation_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasuries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" uuid NOT NULL,
	"address" text NOT NULL,
	"address_display" text NOT NULL,
	"warning_balance_wei" numeric(78, 0) NOT NULL,
	"critical_balance_wei" numeric(78, 0) NOT NULL,
	"recovery_balance_wei" numeric(78, 0) NOT NULL,
	"minimum_reserve_wei" numeric(78, 0) NOT NULL,
	"status" "treasury_status" DEFAULT 'unknown' NOT NULL,
	"last_observed_balance_wei" numeric(78, 0),
	"last_observed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_error_code" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "balance_observations" ADD CONSTRAINT "balance_observations_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_token_hash_key" ON "api_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_name_key" ON "api_credentials" USING btree ("name");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "balance_observations_lookup_idx" ON "balance_observations" USING btree ("chain_id","wallet_address","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chains_slug_key" ON "chains" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "chains_chain_id_key" ON "chains" USING btree ("chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "treasuries_chain_address_key" ON "treasuries" USING btree ("chain_id","address");