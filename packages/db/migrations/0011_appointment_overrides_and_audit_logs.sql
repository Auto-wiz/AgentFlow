ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "manual_payment_override" text;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "hidden_from_ui" boolean NOT NULL DEFAULT false;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "appointment_override_updated_at" timestamptz;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "appointment_override_workspace_user_id" uuid REFERENCES workspace_users(id) ON DELETE SET NULL;

ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_manual_payment_override_check";
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_manual_payment_override_check" CHECK (
    "manual_payment_override" IS NULL
    OR "manual_payment_override" IN ('force_paid', 'force_unpaid')
  );

CREATE TABLE IF NOT EXISTS "workspace_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "actor_workspace_user_id" uuid REFERENCES workspace_users(id) ON DELETE SET NULL,
  "action_kind" text NOT NULL,
  "entity_type" text,
  "entity_id" uuid,
  "location_id" uuid REFERENCES locations(id) ON DELETE SET NULL,
  "summary" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS "workspace_audit_logs_created_at_idx" ON "workspace_audit_logs" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "workspace_audit_logs_action_kind_idx" ON "workspace_audit_logs" ("action_kind");
CREATE INDEX IF NOT EXISTS "workspace_audit_logs_actor_idx" ON "workspace_audit_logs" ("actor_workspace_user_id");
CREATE INDEX IF NOT EXISTS "workspace_audit_logs_location_id_idx" ON "workspace_audit_logs" ("location_id");
