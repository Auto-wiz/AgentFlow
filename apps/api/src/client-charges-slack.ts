import {
  clientResultCharges,
  contacts,
  ghlPaymentOrders,
  invoices,
  locations,
  paymentSources,
  type AgentFlowDb
} from "@agentflow/db";
import { eq } from "drizzle-orm";

import {
  formatClientChargeFailureSlackMessage,
  type ClientChargeFailureSlackInput
} from "./client-charges-logic.js";

export type SlackChargeFailureEnv = {
  /** Slack workflow trigger. POST body is `{ "message": "..." }`. Leave unset to skip alerts. */
  SLACK_CHARGE_FAILURE_WEBHOOK_URL?: string;
};

const SLACK_POST_TIMEOUT_MS = 5_000;

function sourceNameFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const source = (raw as { source?: { name?: unknown } }).source;
  const name = typeof source?.name === "string" ? source.name.trim() : "";
  return name || null;
}

function contactLabel(firstName: string | null, lastName: string | null): string | null {
  const name = [firstName, lastName]
    .map((value) => (value ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

async function postSlackWorkflowMessage(webhookUrl: string | undefined, message: string): Promise<void> {
  const url = webhookUrl?.trim() ?? "";
  if (!url) {
    console.warn("[slack.charge_failure] SLACK_CHARGE_FAILURE_WEBHOOK_URL is not set");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn("[slack.charge_failure] webhook URL is invalid");
    return;
  }
  if (parsed.protocol !== "https:") {
    console.warn("[slack.charge_failure] webhook URL must be https");
    return;
  }

  try {
    const response = await fetch(parsed.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS)
    });
    if (!response.ok) {
      console.warn("[slack.charge_failure] webhook status", response.status);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request_failed";
    console.warn("[slack.charge_failure] webhook request failed", detail);
  }
}

export async function notifyClientChargeStripeFailure(
  env: SlackChargeFailureEnv,
  input: ClientChargeFailureSlackInput
): Promise<void> {
  try {
    await postSlackWorkflowMessage(
      env.SLACK_CHARGE_FAILURE_WEBHOOK_URL,
      formatClientChargeFailureSlackMessage(input)
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "request_failed";
    console.warn("[slack.charge_failure] notify failed", detail);
  }
}

type StoredCharge = Pick<
  typeof clientResultCharges.$inferSelect,
  "locationId" | "paymentOrderId" | "invoiceId" | "chargeAmount" | "chargeCurrency" | "ghlReferenceId"
>;

/** Location, payment, and contact for a charge row already stored when Stripe reports the failure later. */
export async function notifyStoredClientChargeStripeFailure(
  db: AgentFlowDb,
  env: SlackChargeFailureEnv,
  charge: StoredCharge,
  failure: { error: string; ambiguous?: boolean }
): Promise<void> {
  const [location] = await db
    .select({
      locationName: locations.name,
      ghlLocationId: locations.ghlLocationId
    })
    .from(locations)
    .where(eq(locations.id, charge.locationId))
    .limit(1);

  let paymentLabel: string | null = null;
  let externalId = charge.ghlReferenceId;
  let contactName: string | null = null;
  let contactEmail: string | null = null;

  if (charge.paymentOrderId) {
    const [order] = await db
      .select({
        externalId: ghlPaymentOrders.ghlOrderId,
        sourceName: paymentSources.displayName,
        raw: ghlPaymentOrders.raw,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email
      })
      .from(ghlPaymentOrders)
      .leftJoin(paymentSources, eq(ghlPaymentOrders.paymentSourceId, paymentSources.id))
      .leftJoin(contacts, eq(ghlPaymentOrders.contactId, contacts.id))
      .where(eq(ghlPaymentOrders.id, charge.paymentOrderId))
      .limit(1);
    if (order) {
      externalId = order.externalId || externalId;
      paymentLabel = order.sourceName?.trim() || sourceNameFromRaw(order.raw);
      contactName = contactLabel(order.firstName, order.lastName);
      contactEmail = order.email;
    }
  } else if (charge.invoiceId) {
    const [invoice] = await db
      .select({
        externalId: invoices.ghlInvoiceId,
        name: invoices.name,
        title: invoices.title,
        invoiceNumber: invoices.invoiceNumber,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email
      })
      .from(invoices)
      .leftJoin(contacts, eq(invoices.contactId, contacts.id))
      .where(eq(invoices.id, charge.invoiceId))
      .limit(1);
    if (invoice) {
      externalId = invoice.externalId || externalId;
      paymentLabel = invoice.name?.trim() || invoice.title?.trim() || invoice.invoiceNumber?.trim() || null;
      contactName = contactLabel(invoice.firstName, invoice.lastName);
      contactEmail = invoice.email;
    }
  }

  await notifyClientChargeStripeFailure(env, {
    locationName: location?.locationName,
    ghlLocationId: location?.ghlLocationId,
    paymentLabel,
    externalId,
    contactName,
    contactEmail,
    amount: charge.chargeAmount,
    currency: charge.chargeCurrency,
    error: failure.error,
    ambiguous: failure.ambiguous
  });
}
