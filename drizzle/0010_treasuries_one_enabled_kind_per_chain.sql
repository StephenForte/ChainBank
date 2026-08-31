CREATE UNIQUE INDEX "treasuries_one_enabled_kind_per_chain" ON "treasuries" USING btree ("chain_id","kind") WHERE "treasuries"."enabled" = true;
