ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "location_name_synced_at" timestamptz;

COMMENT ON COLUMN "locations"."location_name_synced_at" IS 'Last time display name was confirmed via GHL API (scheduled hydrate or stale-name refresh).';
