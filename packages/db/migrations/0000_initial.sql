CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE message_channel AS ENUM ('sms', 'email');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE webhook_event_status AS ENUM ('queued', 'processed', 'failed');

CREATE TABLE agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_agency_id text NOT NULL UNIQUE,
  name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE cascade,
  ghl_location_id text NOT NULL,
  name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX locations_ghl_location_id_unique ON locations (ghl_location_id);
CREATE INDEX locations_agency_id_idx ON locations (agency_id);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE cascade,
  ghl_contact_id text NOT NULL,
  first_name text,
  last_name text,
  email text,
  phone text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contacts_location_id_ghl_contact_id_unique
  ON contacts (location_id, ghl_contact_id);
CREATE INDEX contacts_location_id_idx ON contacts (location_id);

CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE cascade,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE cascade,
  pending_reply boolean NOT NULL DEFAULT false,
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX threads_location_id_contact_id_unique
  ON threads (location_id, contact_id);
CREATE INDEX threads_pending_reply_idx ON threads (pending_reply);
CREATE INDEX threads_location_id_idx ON threads (location_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE cascade,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE cascade,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE cascade,
  ghl_message_id text NOT NULL,
  channel message_channel NOT NULL,
  direction message_direction NOT NULL,
  subject text,
  body text,
  from_address text,
  to_address text,
  sent_at timestamp with time zone NOT NULL,
  raw jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX messages_thread_id_ghl_message_id_unique
  ON messages (thread_id, ghl_message_id);
CREATE INDEX messages_thread_id_sent_at_idx ON messages (thread_id, sent_at);
CREATE INDEX messages_contact_id_idx ON messages (contact_id);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  source text NOT NULL DEFAULT 'gohighlevel',
  event_type text NOT NULL,
  status webhook_event_status NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL,
  error text,
  processed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX webhook_events_idempotency_key_unique
  ON webhook_events (idempotency_key);
CREATE INDEX webhook_events_status_idx ON webhook_events (status);
