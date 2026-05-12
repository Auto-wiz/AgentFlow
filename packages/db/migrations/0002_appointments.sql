CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE cascade,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ghl_appointment_id text NOT NULL,
  calendar_id text,
  group_id text,
  title text,
  address text,
  status text,
  assigned_user_id text,
  users jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  source text,
  start_time timestamp with time zone,
  end_time timestamp with time zone,
  date_added timestamp with time zone,
  date_updated timestamp with time zone,
  raw jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX appointments_location_id_ghl_appointment_id_unique
  ON appointments (location_id, ghl_appointment_id);
CREATE INDEX appointments_location_id_idx ON appointments (location_id);
CREATE INDEX appointments_contact_id_idx ON appointments (contact_id);
CREATE INDEX appointments_start_time_idx ON appointments (start_time);
