-- Client Charges bills each collected payment, including deposits with no appointment.
-- Existing rows keep their appointment_id. New rows may leave it null.

ALTER TABLE "client_result_charges" ALTER COLUMN "appointment_id" DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "client_result_charges_appointment_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "client_result_charges_appointment_unique"
  ON "client_result_charges" ("appointment_id")
  WHERE "appointment_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_result_charges_payment_order_unique"
  ON "client_result_charges" ("payment_order_id")
  WHERE "payment_order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_result_charges_invoice_unique"
  ON "client_result_charges" ("invoice_id")
  WHERE "invoice_id" IS NOT NULL;
