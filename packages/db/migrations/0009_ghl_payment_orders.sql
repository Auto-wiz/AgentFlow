-- Payment orders synced from GoHighLevel OrderCreate / OrderStatusUpdate webhooks.
-- Used alongside invoices when determining whether an appointment is paid.

CREATE TABLE ghl_payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid (),
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
  ghl_order_id text NOT NULL,
  status text,
  fulfillment_status text,
  live_mode boolean,
  amount integer,
  currency text,
  alt_id text,
  alt_type text,
  ghl_created_at timestamp with time zone,
  ghl_updated_at timestamp with time zone,
  last_event_type text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ghl_payment_orders_location_id_ghl_order_id_unique ON ghl_payment_orders (
  location_id,
  ghl_order_id
);

CREATE INDEX ghl_payment_orders_location_id_idx ON ghl_payment_orders (location_id);
CREATE INDEX ghl_payment_orders_contact_id_idx ON ghl_payment_orders (contact_id);
CREATE INDEX ghl_payment_orders_status_idx ON ghl_payment_orders (status);
