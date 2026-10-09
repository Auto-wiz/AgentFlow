-- Collected HighLevel transactions for an order. Client Charges reads these rows,
-- not the order list price. transaction_sync_* schedules the lookup after the order webhook.

ALTER TABLE ghl_payment_orders
  ADD COLUMN IF NOT EXISTS transaction_sync_after timestamp with time zone,
  ADD COLUMN IF NOT EXISTS transaction_synced_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS transaction_sync_attempts integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ghl_payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES ghl_payment_orders (id) ON DELETE CASCADE,
  ghl_transaction_id text NOT NULL,
  status text,
  amount integer,
  amount_refunded integer,
  currency text,
  entity_id text,
  entity_type text,
  ghl_created_at timestamp with time zone,
  ghl_updated_at timestamp with time zone,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ghl_payment_transactions_location_txn_unique
  ON ghl_payment_transactions (location_id, ghl_transaction_id);

CREATE INDEX IF NOT EXISTS ghl_payment_transactions_order_id_idx
  ON ghl_payment_transactions (order_id);

CREATE INDEX IF NOT EXISTS ghl_payment_orders_transaction_sync_idx
  ON ghl_payment_orders (transaction_sync_after)
  WHERE transaction_synced_at IS NULL;
