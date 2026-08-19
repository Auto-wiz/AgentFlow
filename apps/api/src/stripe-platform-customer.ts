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

export type RefreshStripeCustomerProfileResult =
  | {
      ok: true;
      stripeCustomerId: string;
      customerName: string | null;
      customerEmail: string | null;
    }
  | { ok: false; error: string; code: string };

/** Update stored Stripe name/email (and default PM) for a row that already has cus_. */
export async function refreshStripeCustomerProfileOnLocation(
  stripe: Stripe,
  db: AgentFlowDb,
  locationId: string,
  rawCustomerId?: string | null,
  now = new Date()
): Promise<RefreshStripeCustomerProfileResult> {
  let stripeCustomerId = normalizeStripeCustomerId(rawCustomerId);
  if (!stripeCustomerId) {
    const [row] = await db
      .select({ stripeCustomerId: locationBillingConfigTable.stripeCustomerId })
      .from(locationBillingConfigTable)
      .where(eq(locationBillingConfigTable.locationId, locationId))
      .limit(1);
    stripeCustomerId = normalizeStripeCustomerId(row?.stripeCustomerId);
  }
  if (!stripeCustomerId) {
    return { ok: false, error: "No Stripe customer linked for this location", code: "missing_customer_id" };
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
  const customerName = stripeCustomerDisplayName(customer);
  const customerEmail = stripeCustomerEmail(customer);

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
      stripeCustomerName: customerName,
      stripeCustomerEmail: customerEmail,
      stripeDefaultPaymentMethodId: defaultPm,
      billingReadyAt: billingReady ? now : null,
      updatedAt: now
    })
    .where(eq(locationBillingConfigTable.locationId, locationId));

  return {
    ok: true,
    stripeCustomerId,
    customerName,
    customerEmail
  };
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
