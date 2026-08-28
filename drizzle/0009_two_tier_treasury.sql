CREATE TYPE "public"."treasury_kind" AS ENUM('external', 'operational');--> statement-breakpoint
ALTER TABLE "treasuries" ADD COLUMN "kind" "treasury_kind" DEFAULT 'external' NOT NULL;--> statement-breakpoint
CREATE TABLE "treasury_funding_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_id" uuid NOT NULL,
	"minimum_balance_wei" numeric(78, 0) NOT NULL,
	"target_balance_wei" numeric(78, 0) NOT NULL,
	"maximum_top_up_wei" numeric(78, 0) NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treasury_funding_policies" ADD CONSTRAINT "treasury_funding_policies_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_funding_policies_treasury_id_key" ON "treasury_funding_policies" USING btree ("treasury_id");--> statement-breakpoint
ALTER TABLE "funding_transactions" ALTER COLUMN "managed_wallet_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD COLUMN "destination_treasury_id" uuid;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_destination_treasury_id_treasuries_id_fk" FOREIGN KEY ("destination_treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_transactions" ADD CONSTRAINT "funding_transactions_exactly_one_destination_check" CHECK (("funding_transactions"."managed_wallet_id" is not null and "funding_transactions"."destination_treasury_id" is null) or ("funding_transactions"."managed_wallet_id" is null and "funding_transactions"."destination_treasury_id" is not null));
