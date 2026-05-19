CREATE TYPE workspace_role AS ENUM ('admin', 'user');

CREATE TABLE workspace_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  role workspace_role NOT NULL DEFAULT 'user',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX workspace_users_role_idx ON workspace_users (role);
