CREATE UNIQUE INDEX IF NOT EXISTS "location_billing_config_stripe_account_id_unique"
  ON "location_billing_config" ("stripe_account_id")
  WHERE "stripe_account_id" IS NOT NULL;
