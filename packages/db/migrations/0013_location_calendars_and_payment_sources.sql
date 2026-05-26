CREATE TABLE "location_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
	"ghl_calendar_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "location_calendars_location_ghl_calendar_unique" ON "location_calendars" ("location_id", "ghl_calendar_id");
CREATE INDEX "location_calendars_location_id_idx" ON "location_calendars" ("location_id");

CREATE TABLE "payment_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
	"source_type" text DEFAULT '' NOT NULL,
	"source_sub_type" text DEFAULT '' NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"display_name" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "payment_sources_location_source_key_unique" ON "payment_sources" ("location_id", "source_type", "source_sub_type", "external_id");
CREATE INDEX "payment_sources_location_id_idx" ON "payment_sources" ("location_id");

ALTER TABLE "ghl_payment_orders" ADD COLUMN "payment_source_id" uuid REFERENCES "payment_sources"("id") ON DELETE SET NULL;
CREATE INDEX "ghl_payment_orders_payment_source_id_idx" ON "ghl_payment_orders" ("payment_source_id");
