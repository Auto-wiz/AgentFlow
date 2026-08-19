import { agencies, createDb, locationBillingConfig, locations } from "@agentflow/db";
import { eq } from "drizzle-orm";
import type { NormalizedGhlSaasBillingWebhookEvent } from "@agentflow/shared";

import { extractSaasSubscriptionStripeCustomerId } from "./client-charges-logic.js";
import { syncLocationStripeFromGhlSaas, type GhlStripeSyncEnv } from "./client-charges-ghl-stripe-sync.js";
import { createStripeClient } from "./client-charges-stripe.js";
import { ensureLocationBillingConfigRow, isLocationBillingReady } from "./location-billing-stripe.js";
import { applyPlatformStripeCustomerToLocation } from "./stripe-platform-customer.js";

type Env = GhlStripeSyncEnv & { DATABASE_URL: string };

function customerIdFromSaasWebhookRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  return (
    extractSaasSubscriptionStripeCustomerId(root) ??
    extractSaasSubscriptionStripeCustomerId(root.subscription) ??
    extractSaasSubscriptionStripeCustomerId(root.saas) ??
    extractSaasSubscriptionStripeCustomerId(root.data)
  );
}

export async function processSaasBillingWebhookEvent(
  env: Env,
  event: NormalizedGhlSaasBillingWebhookEvent
) {
  const db = createDb(env.DATABASE_URL);
  const now = new Date();
  const ghlLocationId = event.location.ghlLocationId.trim();
  const ghlAgencyId = event.agency.ghlAgencyId.trim();

  if (!ghlLocationId || !ghlAgencyId) {
    console.warn("[ghl.webhook.saas_billing] missing location or agency id", {
      eventType: event.eventType
    });
    return;
  }

  if (!env.STRIPE_SECRET_KEY?.trim()) {
    console.info("[ghl.webhook.saas_billing] skip — STRIPE_SECRET_KEY not configured");
    return;
  }

  const [agency] = await db
    .insert(agencies)
    .values({
      ghlAgencyId,
      name: event.agency.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: {
        name: event.agency.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: agencies.id });

  if (!agency) {
    console.error("[ghl.webhook.saas_billing] agency upsert failed", { ghlAgencyId });
    return;
  }

  const [location] = await db
    .insert(locations)
    .values({
      agencyId: agency.id,
      ghlLocationId,
      name: event.location.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: locations.ghlLocationId,
      set: {
        agencyId: agency.id,
        name: event.location.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: locations.id });

  if (!location) {
    console.error("[ghl.webhook.saas_billing] location upsert failed", { ghlLocationId });
    return;
  }

  await ensureLocationBillingConfigRow(db, location.id, now);

  const [billing] = await db
    .select({
      stripeCustomerId: locationBillingConfig.stripeCustomerId,
      stripeDefaultPaymentMethodId: locationBillingConfig.stripeDefaultPaymentMethodId
    })
    .from(locationBillingConfig)
    .where(eq(locationBillingConfig.locationId, location.id))
    .limit(1);

  if (
    billing &&
    isLocationBillingReady({
      stripeAccountId: null,
      stripeCustomerId: billing.stripeCustomerId,
      stripeDefaultPaymentMethodId: billing.stripeDefaultPaymentMethodId,
      connectChargesEnabled: false
    })
  ) {
    console.info("[ghl.webhook.saas_billing] skip — billing already ready", {
      ghlLocationId,
      locationId: location.id
    });
    return;
  }

  const cusFromWebhook = customerIdFromSaasWebhookRaw(event.raw);
  const stripe = createStripeClient(env);

  if (cusFromWebhook && stripe) {
    const applied = await applyPlatformStripeCustomerToLocation(
      stripe,
      db,
      location.id,
      cusFromWebhook
    );
    if (applied.ok) {
      console.info("[ghl.webhook.saas_billing] synced from webhook payload", {
        ghlLocationId,
        locationId: location.id,
        billingReady: applied.billingReady,
        eventType: event.eventType
      });
      return;
    }
    console.warn("[ghl.webhook.saas_billing] webhook cus_ apply failed, falling back to GHL fetch", {
      ghlLocationId,
      code: applied.code,
      error: applied.error
    });
  }

  const result = await syncLocationStripeFromGhlSaas(env, db, location.id, ghlLocationId);
  if (result.ok) {
    console.info("[ghl.webhook.saas_billing] synced", {
      ghlLocationId,
      locationId: location.id,
      billingReady: result.billingReady,
      stripeCustomerMasked: result.stripeCustomerMasked,
      eventType: event.eventType
    });
    return;
  }

  if (result.code === "saas_subscription_not_found") {
    console.info("[ghl.webhook.saas_billing] no SaaS subscription yet", {
      ghlLocationId,
      eventType: event.eventType
    });
    return;
  }

  console.warn("[ghl.webhook.saas_billing] sync failed", {
    ghlLocationId,
    eventType: event.eventType,
    code: result.code,
    error: result.error
  });
}
