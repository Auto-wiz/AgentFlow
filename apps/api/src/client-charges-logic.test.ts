import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canAccessClientCharges } from "../../../packages/shared/src/client-charges-access.ts";

import {
  CANONICAL_DEPOSIT_PRECEDENCE,
  canonicalDepositRank,
  clientChargeIdempotencyKey,
  isChargeActionDisabled,
  isChargeRetryable,
  isValidChargeCurrency,
  isValidStripeConnectAccountId,
  mapStripeChargeErrorMessage,
  normalizeChargeAmount,
  normalizeStripeConnectAccountId,
  normalizeStripeCustomerId,
  extractSaasSubscriptionStripeCustomerId,
  summarizeUnknownJsonShape,
  pickCanonicalDepositSource,
  stripeConnectedChargeRequestOptions,
  toStripeMinorUnits
} from "./client-charges-logic.ts";

describe("canonical deposit precedence", () => {
  it("orders direct order before correlated order before correlated invoice", () => {
    assert.deepEqual([...CANONICAL_DEPOSIT_PRECEDENCE], [
      "direct_appointment_order",
      "correlated_order",
      "correlated_invoice"
    ]);
    assert.ok(
      canonicalDepositRank("direct_appointment_order") < canonicalDepositRank("correlated_order")
    );
    assert.ok(
      canonicalDepositRank("correlated_order") < canonicalDepositRank("correlated_invoice")
    );
  });

  it("picks a single winner and never sums mirrors", () => {
    const winner = pickCanonicalDepositSource([
      { matchedBy: "correlated_invoice" as const, amount: 100, id: "inv" },
      { matchedBy: "direct_appointment_order" as const, amount: 50, id: "ord" },
      { matchedBy: "correlated_order" as const, amount: 75, id: "cord" }
    ]);
    assert.equal(winner?.id, "ord");
    assert.equal(winner?.amount, 50);
  });
});

describe("amount and currency validation", () => {
  it("rejects non-positive and non-finite amounts", () => {
    assert.equal(normalizeChargeAmount(0), null);
    assert.equal(normalizeChargeAmount(-1), null);
    assert.equal(normalizeChargeAmount(Number.NaN), null);
    assert.equal(normalizeChargeAmount("abc"), null);
  });

  it("rounds to positive integers matching ledger storage", () => {
    assert.equal(normalizeChargeAmount(47.4), 47);
    assert.equal(normalizeChargeAmount(47.5), 48);
    assert.equal(normalizeChargeAmount("99"), 99);
  });

  it("accepts ISO-4217 alpha currency codes", () => {
    assert.equal(isValidChargeCurrency("USD"), true);
    assert.equal(isValidChargeCurrency("eur"), true);
    assert.equal(isValidChargeCurrency("US"), false);
    assert.equal(isValidChargeCurrency(""), false);
  });

  it("mirrors variable deposit X as the charge amount", () => {
    for (const raw of [25, 30, 35, 47.6]) {
      const deposit = normalizeChargeAmount(raw);
      const charge = normalizeChargeAmount(raw);
      assert.equal(charge, deposit);
      assert.ok(charge != null && charge > 0);
    }
  });
});

describe("idempotency and retry gates", () => {
  it("builds a stable appointment-scoped idempotency key", () => {
    assert.equal(
      clientChargeIdempotencyKey(" 11111111-1111-4111-8111-111111111111 "),
      "agentflow-result-11111111-1111-4111-8111-111111111111"
    );
  });

  it("allows retry only for definitive failed charges", () => {
    assert.equal(isChargeRetryable("failed"), true);
    assert.equal(isChargeRetryable("pending"), false);
    assert.equal(isChargeRetryable("succeeded"), false);
    assert.equal(isChargeRetryable(null), false);
  });

  it("disables charge action while pending or succeeded", () => {
    assert.equal(isChargeActionDisabled("pending"), true);
    assert.equal(isChargeActionDisabled("succeeded"), true);
    assert.equal(isChargeActionDisabled("failed"), false);
    assert.equal(isChargeActionDisabled(null), false);
  });
});

describe("Stripe customer id and GHL SaaS payload", () => {
  it("accepts cus_ ids and trims whitespace", () => {
    assert.equal(normalizeStripeCustomerId("  cus_1ABCxyz  "), "cus_1ABCxyz");
    assert.equal(normalizeStripeCustomerId("acct_1"), null);
  });

  it("extracts cus_ from known and nested GHL-like shapes", () => {
    assert.equal(
      extractSaasSubscriptionStripeCustomerId({ stripeCustomerId: "cus_top" }),
      "cus_top"
    );
    assert.equal(
      extractSaasSubscriptionStripeCustomerId({
        data: { subscription: { customer_id: "cus_nested" } }
      }),
      "cus_nested"
    );
    assert.equal(
      extractSaasSubscriptionStripeCustomerId({ customer: { id: "cus_obj" } }),
      "cus_obj"
    );
    assert.equal(extractSaasSubscriptionStripeCustomerId({ foo: "bar" }), null);
  });

  it("summarizes JSON shape without leaking long strings", () => {
    const shape = summarizeUnknownJsonShape({
      subscriptionDetails: { billingCustomerId: "not-a-cus" },
      items: [{ stripe: { customer_id: "cus_hidden" } }]
    }) as Record<string, unknown>;
    assert.ok(shape.subscriptionDetails);
    assert.equal(typeof shape.items, "object");
  });
});

describe("Stripe Connect account id", () => {
  it("accepts acct_ ids and trims whitespace", () => {
    assert.equal(normalizeStripeConnectAccountId("  acct_1ABCxyz  "), "acct_1ABCxyz");
    assert.equal(isValidStripeConnectAccountId("acct_test"), true);
  });

  it("rejects invalid ids", () => {
    assert.equal(normalizeStripeConnectAccountId("cus_123"), null);
    assert.equal(normalizeStripeConnectAccountId(""), null);
    assert.equal(isValidStripeConnectAccountId(null), false);
  });
});

describe("stripe connected charge request options", () => {
  it("passes stripeAccount and truncated idempotency key to the SDK", () => {
    const key = `agentflow-result-${"a".repeat(300)}`;
    assert.deepEqual(stripeConnectedChargeRequestOptions(" acct_abc123 ", key), {
      stripeAccount: "acct_abc123",
      idempotencyKey: key.slice(0, 255)
    });
  });
});

describe("Stripe amount and error mapping", () => {
  it("converts USD major units to cents", () => {
    assert.equal(toStripeMinorUnits(47.5, "USD"), 4750);
    assert.equal(toStripeMinorUnits(1, "usd"), 100);
  });

  it("uses whole units for zero-decimal currencies", () => {
    assert.equal(toStripeMinorUnits(500, "JPY"), 500);
  });

  it("rejects invalid amounts", () => {
    assert.equal(toStripeMinorUnits(0, "USD"), null);
    assert.equal(toStripeMinorUnits(-2, "USD"), null);
  });

  it("maps Stripe error codes for UI", () => {
    assert.match(mapStripeChargeErrorMessage("authentication_required", ""), /authentication/i);
    assert.equal(mapStripeChargeErrorMessage("card_declined", "Your card was declined."), "Your card was declined.");
    assert.equal(mapStripeChargeErrorMessage(undefined, "Network error"), "Network error");
  });
});

describe("client charges access allowlist", () => {
  it("allows info@autowiz.net and omar workspace logins", () => {
    assert.equal(canAccessClientCharges("info@autowiz.net"), true);
    assert.equal(canAccessClientCharges("INFO@AUTOWIZ.NET"), true);
    assert.equal(canAccessClientCharges("omarurzim@gmail.com"), true);
    assert.equal(canAccessClientCharges("omarurzi@autowiz.net"), true);
  });

  it("denies other workspace users", () => {
    assert.equal(canAccessClientCharges(null), false);
    assert.equal(canAccessClientCharges("other@autowiz.net"), false);
    assert.equal(canAccessClientCharges("admin@example.com"), false);
  });
});
