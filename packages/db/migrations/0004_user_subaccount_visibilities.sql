CREATE TABLE user_subaccount_visibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key text NOT NULL,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE cascade,
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_subaccount_visibilities_user_location_unique
  ON user_subaccount_visibilities (user_key, location_id);
CREATE INDEX user_subaccount_visibilities_user_key_idx
  ON user_subaccount_visibilities (user_key);
CREATE INDEX user_subaccount_visibilities_location_id_idx
  ON user_subaccount_visibilities (location_id);
