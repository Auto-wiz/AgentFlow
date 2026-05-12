CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE cascade,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ghl_invoice_id text NOT NULL,
  status text,
  live_mode boolean,
  amount_paid integer,
  amount_due integer,
  total integer,
  currency text,
  alt_id text,
  alt_type text,
  name text,
  title text,
  invoice_number text,
  issue_date timestamp with time zone,
  due_date timestamp with time zone,
  ghl_created_at timestamp with time zone,
  ghl_updated_at timestamp with time zone,
  last_event_type text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invoices_location_id_ghl_invoice_id_unique
  ON invoices (location_id, ghl_invoice_id);
CREATE INDEX invoices_location_id_idx ON invoices (location_id);
CREATE INDEX invoices_contact_id_idx ON invoices (contact_id);
CREATE INDEX invoices_status_idx ON invoices (status);
CREATE INDEX invoices_amount_due_idx ON invoices (amount_due);
CREATE INDEX invoices_due_date_idx ON invoices (due_date);
