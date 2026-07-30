ALTER TABLE location_billing_config
  ADD COLUMN IF NOT EXISTS stripe_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_default_payment_method_id text,
  ADD COLUMN IF NOT EXISTS connect_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_onboarding_status text,
  ADD COLUMN IF NOT EXISTS connect_details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_ready_at timestamptz;

ALTER TABLE client_result_charges
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS stripe_charge_id text;

CREATE INDEX IF NOT EXISTS client_result_charges_stripe_pi_idx
  ON client_result_charges (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS location_billing_config_stripe_account_idx
  ON location_billing_config (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;
