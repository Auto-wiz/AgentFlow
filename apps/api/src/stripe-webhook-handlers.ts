import { clientResultCharges, createDb, locationBillingConfig } from "@agentflow/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type Stripe from "stripe";

import { createStripeClient, type ClientChargeStripeEnv } from "./client-charges-stripe.js";
import {
  applyStripeAccountSnapshot,
  findLocationIdByStripeAccountId,
  setLocationPaymentMethod
} from "./location-billing-stripe.js";

export type StripeWebhookEnv = ClientChargeStripeEnv & {
  DATABASE_URL: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

type Bindings = { Bindings: StripeWebhookEnv };

function locationIdFromMetadata(meta: Stripe.Metadata | null | undefined): string | null {
  const v = meta?.agentflow_location_id?.trim();
  return v || null;
}

function connectedAccountIdFromEvent(event: Stripe.Event): string | null {
  const account = (event as Stripe.Event & { account?: string | null }).account;
  return typeof account === "string" && account.trim() ? account.trim() : null;
}

async function loadConnectedAccountIdForLocation(
  db: ReturnType<typeof createDb>,
  locationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ stripeAccountId: locationBillingConfig.stripeAccountId })
    .from(locationBillingConfig)
    .where(eq(locationBillingConfig.locationId, locationId))
    .limit(1);
  return row?.stripeAccountId?.trim() ?? null;
}

async function reconcilePaymentIntent(
  db: ReturnType<typeof createDb>,
  intent: Stripe.PaymentIntent,
  now: Date
) {
  const appointmentId = intent.metadata?.appointmentId?.trim();
  const piId = intent.id;

  const [byPi] = await db
    .select()
    .from(clientResultCharges)
    .where(eq(clientResultCharges.stripePaymentIntentId, piId))
    .limit(1);

  let charge = byPi;
  if (!charge && appointmentId) {
    const [byAppt] = await db
      .select()
      .from(clientResultCharges)
      .where(eq(clientResultCharges.appointmentId, appointmentId))
      .limit(1);
    charge = byAppt;
  }
  if (!charge) return;

  const chargeId =
    typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : intent.latest_charge && typeof intent.latest_charge === "object"
        ? intent.latest_charge.id
        : null;

  if (intent.status === "succeeded") {
    await db
      .update(clientResultCharges)
      .set({
        status: "succeeded",
        stripePaymentIntentId: piId,
        stripeChargeId: chargeId,
        lastError: null,
        succeededAt: now,
        failedAt: null,
        updatedAt: now
      })
      .where(eq(clientResultCharges.id, charge.id));
    return;
  }

  if (intent.status === "canceled" || intent.status === "requires_payment_method") {
    await db
      .update(clientResultCharges)
      .set({
        status: "failed",
        stripePaymentIntentId: piId,
        lastError: intent.last_payment_error?.message ?? `PaymentIntent ${intent.status}`,
        failedAt: now,
        updatedAt: now
      })
      .where(eq(clientResultCharges.id, charge.id));
  }
}

async function handleSetupIntentSucceeded(
  env: ClientChargeStripeEnv,
  db: ReturnType<typeof createDb>,
  setup: Stripe.SetupIntent,
  eventConnectedAccountId: string | null
) {
  const locationId = locationIdFromMetadata(setup.metadata);
  const pm =
    typeof setup.payment_method === "string" ? setup.payment_method : setup.payment_method?.id;
  if (!locationId || !pm) return;

  const stripe = createStripeClient(env);
  const connectedAccountId =
    eventConnectedAccountId ?? (await loadConnectedAccountIdForLocation(db, locationId));
  const [row] = await db
    .select({ stripeCustomerId: locationBillingConfig.stripeCustomerId })
    .from(locationBillingConfig)
    .where(eq(locationBillingConfig.locationId, locationId))
    .limit(1);
  const customerId = row?.stripeCustomerId?.trim();
  if (stripe && customerId && connectedAccountId) {
    await stripe.customers.update(
      customerId,
      { invoice_settings: { default_payment_method: pm } },
      { stripeAccount: connectedAccountId }
    );
  }
  await setLocationPaymentMethod(db, locationId, pm);
}

async function handleCheckoutSessionCompleted(
  env: ClientChargeStripeEnv,
  db: ReturnType<typeof createDb>,
  session: Stripe.Checkout.Session,
  eventConnectedAccountId: string | null
) {
  if (session.mode !== "setup") return;
  const locationId = locationIdFromMetadata(session.metadata);
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id;
  const setupIntentId =
    typeof session.setup_intent === "string" ? session.setup_intent : session.setup_intent?.id;
  if (!locationId || !setupIntentId) return;

  const stripe = createStripeClient(env);
  if (!stripe) return;

  const connectedAccountId =
    eventConnectedAccountId ?? (await loadConnectedAccountIdForLocation(db, locationId));
  const setup = connectedAccountId
    ? await stripe.setupIntents.retrieve(setupIntentId, {}, { stripeAccount: connectedAccountId })
    : await stripe.setupIntents.retrieve(setupIntentId);

  if (customerId) {
    await db
      .update(locationBillingConfig)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(locationBillingConfig.locationId, locationId));
  }
  await handleSetupIntentSucceeded(env, db, setup, connectedAccountId);
}

export async function postStripeWebhookHandler(c: Context<Bindings>) {
  const secret = c.env.STRIPE_WEBHOOK_SECRET?.trim();
  const stripe = createStripeClient(c.env);
  if (!secret || !stripe) {
    return c.json({ error: "stripe_webhook_not_configured" }, 500);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "missing_signature" }, 400);

  const rawBody = await c.req.text();
  let event: Stripe.Event;
  try {
    event = (await stripe.webhooks.constructEventAsync(rawBody, signature, secret)) as Stripe.Event;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "invalid_signature", message }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const now = new Date();
  const eventAccountId = connectedAccountIdFromEvent(event);

  try {
    switch (event.type) {
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        let locationId = account.metadata?.agentflow_location_id?.trim() ?? "";
        if (!locationId) {
          locationId = (await findLocationIdByStripeAccountId(db, account.id)) ?? "";
        }
        if (locationId) {
          await applyStripeAccountSnapshot(db, locationId, account, now);
        }
        break;
      }
      case "setup_intent.succeeded": {
        await handleSetupIntentSucceeded(
          c.env,
          db,
          event.data.object as Stripe.SetupIntent,
          eventAccountId
        );
        break;
      }
      case "checkout.session.completed": {
        await handleCheckoutSessionCompleted(
          c.env,
          db,
          event.data.object as Stripe.Checkout.Session,
          eventAccountId
        );
        break;
      }
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed": {
        await reconcilePaymentIntent(db, event.data.object as Stripe.PaymentIntent, now);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error("[stripe.webhook]", event.type, error);
    return c.json({ error: "webhook_handler_failed" }, 500);
  }

  return c.json({ received: true });
}
