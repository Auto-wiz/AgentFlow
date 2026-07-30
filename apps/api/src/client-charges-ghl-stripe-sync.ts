import { createDb } from "@agentflow/db";

import { createStripeClient } from "./client-charges-stripe.js";
import {
  fetchGhlSaasSubscriptionForLocation,
  type GhlSaasFetchOptions
} from "./ghl-saas-subscription.js";
import type { GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";
import { maskStripeCustomerId } from "./location-billing-stripe.js";
import { applyPlatformStripeCustomerToLocation } from "./stripe-platform-customer.js";

export type GhlStripeSyncEnv = GhlOAuthTokenEnv & {
  STRIPE_SECRET_KEY?: string;
};

export type SyncLocationStripeFromGhlResult =
  | {
      ok: true;
      stripeCustomerId: string;
      stripeCustomerMasked: string | null;
      billingReady: boolean;
      hasPaymentMethod: boolean;
      customerEmail: string | null;
      customerName: string | null;
      ghlCustomerId: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      code: string;
      payloadShape?: unknown;
      ghlApiMessage?: string;
      oauthScopeOnFile?: string | null;
    };

export async function syncLocationStripeFromGhlSaas(
  env: GhlStripeSyncEnv,
  db: ReturnType<typeof createDb>,
  locationId: string,
  ghlLocationId: string,
  ghlFetchOpts?: GhlSaasFetchOptions
): Promise<SyncLocationStripeFromGhlResult> {
  const saas = await fetchGhlSaasSubscriptionForLocation(env, db, ghlLocationId, ghlFetchOpts);
  if (!saas.ok) {
    return {
      ok: false,
      status: saas.status ?? 502,
      error: saas.error,
      code: saas.code,
      ...(saas.code === "customer_id_missing" && saas.payloadShape != null
        ? { payloadShape: saas.payloadShape }
        : {}),
      ...(saas.ghlApiMessage ? { ghlApiMessage: saas.ghlApiMessage } : {}),
      ...(saas.oauthScopeOnFile !== undefined ? { oauthScopeOnFile: saas.oauthScopeOnFile } : {})
    };
  }

  const stripe = createStripeClient(env);
  if (!stripe) {
    return {
      ok: false,
      status: 500,
      error: "Stripe is not configured",
      code: "stripe_not_configured"
    };
  }

  const applied = await applyPlatformStripeCustomerToLocation(stripe, db, locationId, saas.customerId);
  if (!applied.ok) {
    return {
      ok: false,
      status: applied.code === "stripe_customer_in_use" ? 409 : 400,
      error: applied.error,
      code: applied.code
    };
  }

  return {
    ok: true,
    stripeCustomerId: applied.stripeCustomerId,
    stripeCustomerMasked: maskStripeCustomerId(applied.stripeCustomerId),
    billingReady: applied.billingReady,
    hasPaymentMethod: Boolean(applied.stripeDefaultPaymentMethodId),
    customerEmail: applied.customerEmail,
    customerName: applied.customerName,
    ghlCustomerId: saas.customerId
  };
}
