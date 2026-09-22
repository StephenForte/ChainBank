CREATE TYPE "public"."dashboard_role" AS ENUM('admin', 'operator', 'viewer');--> statement-breakpoint
ALTER TYPE "public"."actor_type" ADD VALUE 'dashboard_user';--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dashboard_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "dashboard_role" NOT NULL,
	"password_hash" text NOT NULL,
	"password_params" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_user_id_dashboard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."dashboard_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_sessions_token_hash_key" ON "dashboard_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "dashboard_sessions_user_id_idx" ON "dashboard_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_users_email_lower_key" ON "dashboard_users" USING btree (lower("email"));