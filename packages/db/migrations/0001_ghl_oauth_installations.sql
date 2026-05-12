CREATE TYPE ghl_user_type AS ENUM ('Company', 'Location');

CREATE TABLE ghl_oauth_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  location_id text NOT NULL DEFAULT '',
  user_id text,
  user_type ghl_user_type NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  token_type text NOT NULL DEFAULT 'Bearer',
  scope text,
  refresh_token_id text,
  expires_at timestamp with time zone NOT NULL,
  raw jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ghl_oauth_installations_company_location_user_type_unique
  ON ghl_oauth_installations (company_id, location_id, user_type);
CREATE INDEX ghl_oauth_installations_company_id_idx
  ON ghl_oauth_installations (company_id);
CREATE INDEX ghl_oauth_installations_location_id_idx
  ON ghl_oauth_installations (location_id);
