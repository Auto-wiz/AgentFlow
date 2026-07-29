CREATE TABLE "location_billing_config" (
	"location_id" uuid PRIMARY KEY NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
	"enabled" boolean DEFAULT false NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"ghl_meter_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_workspace_user_id" uuid REFERENCES "workspace_users"("id") ON DELETE SET NULL
);
CREATE INDEX "location_billing_config_enabled_idx" ON "location_billing_config" ("enabled");

CREATE TABLE "client_result_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE RESTRICT,
	"appointment_id" uuid NOT NULL REFERENCES "appointments"("id") ON DELETE RESTRICT,
	"deposit_source_kind" text NOT NULL,
	"payment_order_id" uuid REFERENCES "ghl_payment_orders"("id") ON DELETE RESTRICT,
	"invoice_id" uuid REFERENCES "invoices"("id") ON DELETE RESTRICT,
	"deposit_amount" integer NOT NULL,
	"deposit_currency" text NOT NULL,
	"charge_amount" integer NOT NULL,
	"charge_currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"ghl_reference_id" text,
	"ghl_transaction_id" text,
	"request_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_by_workspace_user_id" uuid REFERENCES "workspace_users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "client_result_charges_source_kind_check" CHECK ("deposit_source_kind" IN ('payment_order', 'invoice')),
	CONSTRAINT "client_result_charges_source_ref_check" CHECK (
		("deposit_source_kind" = 'payment_order' AND "payment_order_id" IS NOT NULL AND "invoice_id" IS NULL)
		OR ("deposit_source_kind" = 'invoice' AND "invoice_id" IS NOT NULL AND "payment_order_id" IS NULL)
	),
	CONSTRAINT "client_result_charges_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'reversed')),
	CONSTRAINT "client_result_charges_amount_check" CHECK ("deposit_amount" > 0 AND "charge_amount" > 0)
);
CREATE UNIQUE INDEX "client_result_charges_appointment_unique" ON "client_result_charges" ("appointment_id");
CREATE UNIQUE INDEX "client_result_charges_idempotency_unique" ON "client_result_charges" ("idempotency_key");
CREATE INDEX "client_result_charges_location_created_idx" ON "client_result_charges" ("location_id", "created_at" DESC);
CREATE INDEX "client_result_charges_status_idx" ON "client_result_charges" ("status");
CREATE INDEX "client_result_charges_payment_order_idx" ON "client_result_charges" ("payment_order_id");
CREATE INDEX "client_result_charges_invoice_idx" ON "client_result_charges" ("invoice_id");

CREATE TABLE "client_result_charge_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charge_id" uuid NOT NULL REFERENCES "client_result_charges"("id") ON DELETE RESTRICT,
	"event_type" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_workspace_user_id" uuid REFERENCES "workspace_users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_result_charge_events_type_check" CHECK ("event_type" IN ('claimed', 'request_sent', 'succeeded', 'failed', 'reversed'))
);
CREATE INDEX "client_result_charge_events_charge_created_idx" ON "client_result_charge_events" ("charge_id", "created_at");
