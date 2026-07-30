import type { createDb } from "@agentflow/db";
import { locationBillingConfig as locationBillingConfigTable } from "@agentflow/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

export type AgentFlowDb = ReturnType<typeof createDb>;

export type LocationBillingStripeRow = {
  locationId: string;
  enabled: boolean;
  currency: string;
  stripeAccountId: string | null;
  stripeCustomerId: string | null;
  stripeDefaultPaymentMethodId: string | null;
  connectChargesEnabled: boolean;
  connectPayoutsEnabled: boolean;
  connectOnboardingStatus: string | null;
  connectDetailsSubmitted: boolean;
  billingReadyAt: Date | null;
};

export function maskStripeAccountId(accountId: string | null | undefined): string | null {
  const v = accountId?.trim();
  if (!v) return null;
  if (v.length <= 8) return v;
  return `${v.slice(0, 7)}…${v.slice(-4)}`;
}

export function isLocationBillingReady(row: Pick<
  LocationBillingStripeRow,
  "stripeCustomerId" | "stripeDefaultPaymentMethodId" | "connectChargesEnabled"
>): boolean {
  return Boolean(
    row.stripeCustomerId?.trim() &&
      row.stripeDefaultPaymentMethodId?.trim() &&
      row.connectChargesEnabled
  );
}

export async function ensureLocationBillingConfigRow(db: AgentFlowDb, locationId: string, now = new Date()) {
  await db
    .insert(locationBillingConfigTable)
    .values({ locationId, updatedAt: now })
    .onConflictDoNothing();
}

export async function applyStripeAccountSnapshot(
  db: AgentFlowDb,
  locationId: string,
  account: Stripe.Account,
  now = new Date()
) {
  await ensureLocationBillingConfigRow(db, locationId, now);
  const chargesEnabled = Boolean(account.charges_enabled);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);
  const onboardingStatus =
    typeof account.requirements?.disabled_reason === "string"
      ? account.requirements.disabled_reason
      : detailsSubmitted
        ? "complete"
        : "pending";

  const [existing] = await db
    .select({
      stripeCustomerId: locationBillingConfigTable.stripeCustomerId,
      stripeDefaultPaymentMethodId: locationBillingConfigTable.stripeDefaultPaymentMethodId
    })
    .from(locationBillingConfigTable)
    .where(eq(locationBillingConfigTable.locationId, locationId))
    .limit(1);

  const billingReady = isLocationBillingReady({
    stripeCustomerId: existing?.stripeCustomerId ?? null,
    stripeDefaultPaymentMethodId: existing?.stripeDefaultPaymentMethodId ?? null,
    connectChargesEnabled: chargesEnabled
  });

  await db
    .update(locationBillingConfigTable)
    .set({
      stripeAccountId: account.id,
      connectChargesEnabled: chargesEnabled,
      connectPayoutsEnabled: payoutsEnabled,
      connectDetailsSubmitted: detailsSubmitted,
      connectOnboardingStatus: onboardingStatus,
      billingReadyAt: billingReady ? now : null,
      updatedAt: now
    })
    .where(eq(locationBillingConfigTable.locationId, locationId));
}

export async function setLocationPaymentMethod(
  db: AgentFlowDb,
  locationId: string,
  paymentMethodId: string,
  now = new Date()
) {
  const [row] = await db
    .select({
      stripeCustomerId: locationBillingConfigTable.stripeCustomerId,
      connectChargesEnabled: locationBillingConfigTable.connectChargesEnabled
    })
    .from(locationBillingConfigTable)
    .where(eq(locationBillingConfigTable.locationId, locationId))
    .limit(1);

  const billingReady = isLocationBillingReady({
    stripeCustomerId: row?.stripeCustomerId ?? null,
    stripeDefaultPaymentMethodId: paymentMethodId,
    connectChargesEnabled: row?.connectChargesEnabled ?? false
  });

  await db
    .update(locationBillingConfigTable)
    .set({
      stripeDefaultPaymentMethodId: paymentMethodId,
      billingReadyAt: billingReady ? now : null,
      updatedAt: now
    })
    .where(eq(locationBillingConfigTable.locationId, locationId));
}
