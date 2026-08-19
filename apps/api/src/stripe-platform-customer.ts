import { locationBillingConfig as locationBillingConfigTable } from "@agentflow/db/schema";
import { and, eq, ne } from "drizzle-orm";
import type Stripe from "stripe";

import {
  normalizeStripeCustomerId,
  pickDefaultPaymentMethodIdFromStripeCustomer,
  stripeCustomerDisplayName,
  stripeCustomerEmail
} from "./client-charges-logic.js";
import {
  ensureLocationBillingConfigRow,
  isLocationBillingReady,
  type AgentFlowDb
} from "./location-billing-stripe.js";

export type ApplyPlatformCustomerResult =
  | {
      ok: true;
      stripeCustomerId: string;
      stripeDefaultPaymentMethodId: string | null;
      billingReady: boolean;
      customerEmail: string | null;
      customerName: string | null;
    }
  | { ok: false; error: string; code: string };

export async function assertStripeCustomerNotLinkedElsewhere(
  db: AgentFlowDb,
  locationId: string,
  stripeCustomerId: string
): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  const [existing] = await db
    .select({ locationId: locationBillingConfigTable.locationId })
    .from(locationBillingConfigTable)
    .where(
      and(
        eq(locationBillingConfigTable.stripeCustomerId, stripeCustomerId),
        ne(locationBillingConfigTable.locationId, locationId)
      )
    )
    .limit(1);
  if (existing) {
    return {
      ok: false,
      error: "That Stripe customer is already linked to another subaccount.",
      code: "stripe_customer_in_use"
    };
  }
  return { ok: true };
}

export async function applyPlatformStripeCustomerToLocation(
  stripe: Stripe,
  db: AgentFlowDb,
  locationId: string,
  rawCustomerId: unknown,
  now = new Date()
): Promise<ApplyPlatformCustomerResult> {
  const stripeCustomerId = normalizeStripeCustomerId(rawCustomerId);
  if (!stripeCustomerId) {
    return { ok: false, error: "Invalid Stripe customer id (expected cus_…)", code: "invalid_customer_id" };
  }

  const unique = await assertStripeCustomerNotLinkedElsewhere(db, locationId, stripeCustomerId);
  if (!unique.ok) {
    return { ok: false, error: unique.error, code: unique.code };
  }

  let customer: Stripe.Customer;
  try {
    const retrieved = await stripe.customers.retrieve(stripeCustomerId);
    if (retrieved.deleted) {
      return { ok: false, error: "Stripe customer was deleted", code: "customer_deleted" };
    }
    customer = retrieved as Stripe.Customer;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, code: "stripe_customer_not_found" };
  }

  const paymentMethods = await stripe.paymentMethods.list({
    customer: stripeCustomerId,
    type: "card",
    limit: 10
  });
  const pmIds = paymentMethods.data.map((pm) => pm.id);
  const defaultPm = pickDefaultPaymentMethodIdFromStripeCustomer(customer, pmIds);

  await ensureLocationBillingConfigRow(db, locationId, now);

  const [existing] = await db
    .select({
      stripeAccountId: locationBillingConfigTable.stripeAccountId,
      connectChargesEnabled: locationBillingConfigTable.connectChargesEnabled
    })
    .from(locationBillingConfigTable)
    .where(eq(locationBillingConfigTable.locationId, locationId))
    .limit(1);

  const billingReady = isLocationBillingReady({
    stripeAccountId: existing?.stripeAccountId ?? null,
    stripeCustomerId,
    stripeDefaultPaymentMethodId: defaultPm,
    connectChargesEnabled: existing?.connectChargesEnabled ?? false
  });

  await db
    .update(locationBillingConfigTable)
    .set({
      stripeCustomerId,
      stripeCustomerName: stripeCustomerDisplayName(customer),
      stripeCustomerEmail: stripeCustomerEmail(customer),
      stripeDefaultPaymentMethodId: defaultPm,
      billingReadyAt: billingReady ? now : null,
      updatedAt: now
    })
    .where(eq(locationBillingConfigTable.locationId, locationId));

  return {
    ok: true,
    stripeCustomerId,
    stripeDefaultPaymentMethodId: defaultPm,
    billingReady,
    customerEmail: stripeCustomerEmail(customer),
    customerName: stripeCustomerDisplayName(customer)
  };
}
