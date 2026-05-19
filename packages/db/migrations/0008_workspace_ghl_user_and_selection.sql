-- Evolve workspace users for GoHighLevel userId identity; selections per user.

ALTER TABLE workspace_users DROP CONSTRAINT IF EXISTS workspace_users_email_key;

ALTER TABLE workspace_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE workspace_users ALTER COLUMN password_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_users_email_unique_partial
ON workspace_users (email) WHERE email IS NOT NULL;

ALTER TABLE workspace_users ADD COLUMN IF NOT EXISTS ghl_user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_users_ghl_user_id_unique
ON workspace_users (ghl_user_id) WHERE ghl_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_user_location_selection (
  workspace_user_id uuid NOT NULL REFERENCES workspace_users (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_user_id, location_id)
);

CREATE INDEX IF NOT EXISTS workspace_user_location_sel_loc_idx ON workspace_user_location_selection (location_id);
