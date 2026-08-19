ALTER TABLE "location_billing_config"
  ADD COLUMN IF NOT EXISTS "stripe_customer_name" text,
  ADD COLUMN IF NOT EXISTS "stripe_customer_email" text;
