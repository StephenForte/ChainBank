CREATE TYPE "public"."funding_operation_status" AS ENUM('pending', 'in_progress', 'succeeded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."funding_transaction_status" AS ENUM('created', 'submitted', 'confirmed', 'reverted', 'replaced', 'dropped', 'failed');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_type" text NOT NULL,
	"severity" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"state" text NOT NULL,
	"first_triggered_at" timestamp with time zone NOT NULL,
	"last_evaluated_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_type" text NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"idempotency_key" text,
	"status" "funding_operation_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error_summary" text
);
--> statement-breakpoint
CREATE TABLE "funding_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"managed_wallet_id" uuid NOT NULL,
	"minimum_balance_wei" numeric(78, 0) NOT NULL,
	"target_balance_wei" numeric(78, 0) NOT NULL,
	"maximum_top_up_wei" numeric(78, 0) NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"treasury_id" uuid NOT NULL,
	"managed_wallet_id" uuid NOT NULL,
	"amount_wei" numeric(78, 0) NOT NULL,
	"transaction_hash" text,
	"nonce" integer,
	"status" "funding_transaction_status" DEFAULT 'created' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "managed_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"role" text NOT NULL,
	"address" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"critical_at_startup" boolean DEFAULT false NOT NULL,
	"reconciliation_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_operations" ADD CONSTRAINT "funding_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_operations" ADD CONSTRAINT "funding_operations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_policies" ADD CONSTRAINT "funding_policies_managed_wallet_id_managed_wallets_id_fk" FOREIGN KEY ("managed_wallet_id") REFERENCES "public"."managed_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_operation_id_funding_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."funding_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_managed_wallet_id_managed_wallets_id_fk" FOREIGN KEY ("managed_wallet_id") REFERENCES "public"."managed_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_wallets" ADD CONSTRAINT "managed_wallets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_wallets" ADD CONSTRAINT "managed_wallets_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_slug_key" ON "environments" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_operations_requested_by_idempotency_key" ON "funding_operations" USING btree ("requested_by","idempotency_key") WHERE "funding_operations"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "funding_policies_managed_wallet_id_key" ON "funding_policies" USING btree ("managed_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_wallets_chain_address_key" ON "managed_wallets" USING btree ("chain_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_key" ON "projects" USING btree ("slug");