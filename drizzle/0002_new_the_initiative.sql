CREATE TABLE "api_credential_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_credential_scopes" ADD CONSTRAINT "api_credential_scopes_credential_id_api_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."api_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_credential_scopes" ADD CONSTRAINT "api_credential_scopes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_credential_scopes" ADD CONSTRAINT "api_credential_scopes_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credential_scopes_project_wide_key" ON "api_credential_scopes" USING btree ("credential_id","project_id") WHERE "api_credential_scopes"."environment_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credential_scopes_environment_key" ON "api_credential_scopes" USING btree ("credential_id","project_id","environment_id") WHERE "api_credential_scopes"."environment_id" is not null;