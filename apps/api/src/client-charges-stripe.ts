import Stripe from "stripe";

import {
  isStripeChargeAmbiguousHttpStatus,
  mapStripeChargeErrorMessage,
  toStripeMinorUnits
} from "./client-charges-logic.js";

export type ClientChargeStripeEnv = {
  STRIPE_SECRET_KEY?: string;
};

export type StripePlatformChargeRequest = {
  customerId: string;
  paymentMethodId: string;
  amountMajor: number;
  currency: string;
  idempotencyKey: string;
  description: string;
  metadata: Record<string, string>;
};

export type StripePlatformChargeResult =
  | {
      ok: true;
      ambiguous: false;
      status: number;
      request: Record<string, unknown>;
      response: Record<string, unknown>;
      paymentIntentId: string;
      chargeId: string | null;
    }
  | {
      ok: false;
      ambiguous: boolean;
      status: number | null;
      error: string;
      request: Record<string, unknown>;
      response: Record<string, unknown>;
    };

function getStripe(env: ClientChargeStripeEnv): Stripe | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createStripeClient(env: ClientChargeStripeEnv): Stripe | null {
  return getStripe(env);
}

export async function createStripePlatformCharge(
  env: ClientChargeStripeEnv,
  input: StripePlatformChargeRequest
): Promise<StripePlatformChargeResult> {
  const stripe = getStripe(env);
  const minor = toStripeMinorUnits(input.amountMajor, input.currency);
  const request: Record<string, unknown> = {
    customerId: input.customerId,
    paymentMethodId: input.paymentMethodId,
    amountMajor: input.amountMajor,
    amountMinor: minor,
    currency: input.currency.toUpperCase(),
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata
  };

  if (!stripe) {
    return {
      ok: false,
      ambiguous: false,
      status: null,
      error: "STRIPE_SECRET_KEY is not configured",
      request,
      response: {}
    };
  }
  if (minor == null) {
    return {
      ok: false,
      ambiguous: false,
      status: null,
      error: "Charge amount must be positive",
      request,
      response: {}
    };
  }

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: minor,
        currency: input.currency.trim().toLowerCase(),
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        off_session: true,
        confirm: true,
        description: input.description,
        metadata: input.metadata
      },
      { idempotencyKey: input.idempotencyKey.slice(0, 255) }
    );

    const response = asRecord(intent);
    if (intent.status === "succeeded") {
      const chargeId =
        typeof intent.latest_charge === "string"
          ? intent.latest_charge
          : intent.latest_charge && typeof intent.latest_charge === "object"
            ? (intent.latest_charge as Stripe.Charge).id
            : null;
      return {
        ok: true,
        ambiguous: false,
        status: 200,
        request,
        response,
        paymentIntentId: intent.id,
        chargeId
      };
    }

    if (intent.status === "processing") {
      return {
        ok: false,
        ambiguous: true,
        status: 202,
        error: `PaymentIntent is processing (${intent.status})`,
        request,
        response
      };
    }

    return {
      ok: false,
      ambiguous: false,
      status: 402,
      error: `PaymentIntent status: ${intent.status}`,
      request,
      response
    };
  } catch (caught) {
    if (caught instanceof Stripe.errors.StripeCardError) {
      return {
        ok: false,
        ambiguous: false,
        status: caught.statusCode ?? 402,
        error: mapStripeChargeErrorMessage(caught.code, caught.message),
        request,
        response: asRecord(caught.raw)
      };
    }
    if (caught instanceof Stripe.errors.StripeError) {
      const status = caught.statusCode ?? undefined;
      return {
        ok: false,
        ambiguous: isStripeChargeAmbiguousHttpStatus(status),
        status: status ?? null,
        error: mapStripeChargeErrorMessage(caught.code, caught.message),
        request,
        response: asRecord(caught.raw)
      };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      ambiguous: true,
      status: null,
      error: message,
      request,
      response: {}
    };
  }
}
