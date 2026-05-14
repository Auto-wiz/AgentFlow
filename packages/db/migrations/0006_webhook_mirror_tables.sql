CREATE OR REPLACE FUNCTION create_ghl_webhook_mirror_table(table_name text, index_prefix text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key text NOT NULL,
      webhook_type text NOT NULL,
      company_id text,
      location_id text,
      contact_id text,
      entity_id text,
      event_timestamp timestamp with time zone,
      payload jsonb NOT NULL,
      headers jsonb NOT NULL DEFAULT ''{}''::jsonb,
      raw_body text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    )',
    table_name
  );
  EXECUTE format(
    'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (idempotency_key)',
    index_prefix || '_idempotency_key_unique',
    table_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I (webhook_type)',
    index_prefix || '_webhook_type_idx',
    table_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I (location_id)',
    index_prefix || '_location_id_idx',
    table_name
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I ON %I (created_at)',
    index_prefix || '_created_at_idx',
    table_name
  );
END;
$$;

SELECT create_ghl_webhook_mirror_table('ghl_webhook_mirror_events', 'ghl_wh_mirror_events');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_app_mirror', 'ghl_wh_app');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_appointment_mirror', 'ghl_wh_appt');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_association_mirror', 'ghl_wh_assoc');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_campaign_mirror', 'ghl_wh_campaign');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_contact_mirror', 'ghl_wh_contact');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_conversation_mirror', 'ghl_wh_conversation');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_external_auth_mirror', 'ghl_wh_external_auth');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_invoice_mirror', 'ghl_wh_invoice');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_email_stats_mirror', 'ghl_wh_email_stats');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_location_mirror', 'ghl_wh_location');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_note_mirror', 'ghl_wh_note');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_object_schema_mirror', 'ghl_wh_object_schema');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_opportunity_mirror', 'ghl_wh_opportunity');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_order_mirror', 'ghl_wh_order');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_price_mirror', 'ghl_wh_price');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_product_mirror', 'ghl_wh_product');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_record_mirror', 'ghl_wh_record');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_relation_mirror', 'ghl_wh_relation');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_saas_plan_mirror', 'ghl_wh_saas_plan');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_task_mirror', 'ghl_wh_task');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_user_mirror', 'ghl_wh_user');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_voice_ai_mirror', 'ghl_wh_voice_ai');
SELECT create_ghl_webhook_mirror_table('ghl_webhook_misc_mirror', 'ghl_wh_misc');

DROP FUNCTION create_ghl_webhook_mirror_table(text, text);
