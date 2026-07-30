import { agencies, createDb, locationBillingConfig, locations } from "@agentflow/db";
import { eq } from "drizzle-orm";
import type { NormalizedGhlSaasBillingWebhookEvent } from "@agentflow/shared";

import { syncLocationStripeFromGhlSaas, type GhlStripeSyncEnv } from "./client-charges-ghl-stripe-sync.js";

type Env = GhlStripeSyncEnv & { DATABASE_URL: string };

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

  const [billing] = await db
    .select({
      stripeCustomerId: locationBillingConfig.stripeCustomerId,
      stripeDefaultPaymentMethodId: locationBillingConfig.stripeDefaultPaymentMethodId
    })
    .from(locationBillingConfig)
    .where(eq(locationBillingConfig.locationId, location.id))
    .limit(1);

  if (billing?.stripeCustomerId?.trim() && billing.stripeDefaultPaymentMethodId?.trim()) {
    console.info("[ghl.webhook.saas_billing] skip — billing already ready", {
      ghlLocationId,
      locationId: location.id
    });
    return;
  }

  const result = await syncLocationStripeFromGhlSaas(env, db, location.id, ghlLocationId);
  if (result.ok) {
    console.info("[ghl.webhook.saas_billing] synced", {
      ghlLocationId,
      locationId: location.id,
      billingReady: result.billingReady,
      stripeCustomerMasked: result.stripeCustomerMasked
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
