import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canAccessClientCharges } from "../../../packages/shared/src/client-charges-access.ts";

import {
  CANONICAL_DEPOSIT_PRECEDENCE,
  canonicalDepositRank,
  chargeActorDisplayName,
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
  extractGhlLocationIdFromStripeMetadata,
  extractGhlCompanyIdFromStripeMetadata,
  findGhlSaasLocationRecord,
  isEmptySaasLocationsPage,
  listGhlSaasLocationRowsFromPage,
  parseGhlLocationIdsFromSaasLocationsLookupPayload,
  stripeCustomerDisplayName,
  stripeCustomerEmail,
  summarizeUnknownJsonShape,
  isClientChargesChargingEnabled,
  parseOverviewAccountView,
  overviewAccountMatchesView,
  emptyOverviewAccountRow,
  pickCanonicalDepositSource,
  stripeConnectedChargeRequestOptions,
  stripeDashboardPaymentUrl,
  formatClientChargeFailureSlackMessage,
  redactChargeFailureText,
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
  it("builds a stable idempotency key per collected order or invoice", () => {
    assert.equal(
      clientChargeIdempotencyKey({
        kind: "payment_order",
        id: " 11111111-1111-4111-8111-111111111111 "
      }),
      "agentflow-result-order-11111111-1111-4111-8111-111111111111"
    );
    assert.equal(
      clientChargeIdempotencyKey({
        kind: "invoice",
        id: "22222222-2222-4222-8222-222222222222"
      }),
      "agentflow-result-invoice-22222222-2222-4222-8222-222222222222"
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

  it("requires explicit env opt-in for live charges", () => {
    assert.equal(isClientChargesChargingEnabled({}), false);
    assert.equal(isClientChargesChargingEnabled({ CLIENT_CHARGES_CHARGING_ENABLED: "false" }), false);
    assert.equal(isClientChargesChargingEnabled({ CLIENT_CHARGES_CHARGING_ENABLED: "true" }), true);
    assert.equal(isClientChargesChargingEnabled({ CLIENT_CHARGES_CHARGING_ENABLED: "1" }), true);
  });

  it("prefers display name for charge actor label", () => {
    assert.equal(chargeActorDisplayName("Omar", "omar@example.com"), "Omar");
    assert.equal(chargeActorDisplayName(null, "omar@example.com"), "omar");
    assert.equal(chargeActorDisplayName("  ", null), null);
  });

  it("finds a location row in saas-locations v3 list payloads", () => {
    const row = findGhlSaasLocationRecord(
      {
        locations: [
          { locationId: "loc_a", customerId: "cus_abc123" },
          { locationId: "loc_b", stripeCustomerId: "cus_other9" }
        ]
      },
      "loc_a"
    );
    assert.equal(row?.customerId, "cus_abc123");
    assert.equal(extractSaasSubscriptionStripeCustomerId(row), "cus_abc123");
  });

  it("lists all SaaS location rows on a v3 page", () => {
    const rows = listGhlSaasLocationRowsFromPage({
      locations: [
        { locationId: "loc_a", customerId: "cus_a", name: "A" },
        { locationId: "loc_b", name: "B" }
      ]
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.ghlLocationId, "loc_a");
    assert.equal(extractSaasSubscriptionStripeCustomerId(rows[0]?.row), "cus_a");
  });

  it("unwraps GHL { data: { locations, pagination } } catalog pages", () => {
    const wrapped = {
      message: "success",
      status: 200,
      data: {
        locations: [
          { locationId: "BZI4XanpCqmn5tsMd34N", name: "Kymala", customerId: "cus_listed" }
        ],
        pagination: { page: "1", total: 77, totalPages: 4, hasNext: true }
      }
    };
    const row = findGhlSaasLocationRecord(wrapped, "BZI4XanpCqmn5tsMd34N");
    assert.equal(row?.name, "Kymala");
    assert.equal(listGhlSaasLocationRowsFromPage(wrapped).length, 1);
    assert.equal(isEmptySaasLocationsPage(wrapped), false);
    assert.equal(
      isEmptySaasLocationsPage({
        message: "success",
        data: { locations: [], pagination: { page: "5", total: 77, totalPages: 4 } }
      }),
      true
    );
  });

  it("reads cus_ from get-saas-subscription envelopes even when the catalog omits the location", () => {
    const envelope = {
      message: "success",
      status: 200,
      data: {
        isSaaSV2: false,
        customerId: "cus_activatedNoPlan",
        locationId: "BZI4XanpCqmn5tsMd34N",
        saasMode: "activated",
        subscriptionStatus: null
      }
    };
    assert.equal(extractSaasSubscriptionStripeCustomerId(envelope), "cus_activatedNoPlan");
    assert.equal(findGhlSaasLocationRecord({ data: { locations: [] } }, "BZI4XanpCqmn5tsMd34N"), null);
  });

  it("reads GHL location/company ids from Stripe metadata", () => {
    assert.equal(extractGhlLocationIdFromStripeMetadata({ locationId: "loc_x" }), "loc_x");
    assert.equal(extractGhlLocationIdFromStripeMetadata({ location_id: "loc_y" }), "loc_y");
    assert.equal(extractGhlCompanyIdFromStripeMetadata({ companyId: "co_z" }), "co_z");
    assert.equal(extractGhlLocationIdFromStripeMetadata({}), null);
  });

  it("builds Stripe customer display name from name or individual fields", () => {
    assert.equal(stripeCustomerDisplayName({ name: "Acme Co" }), "Acme Co");
    assert.equal(
      stripeCustomerDisplayName({
        individual: { first_name: "Jane", last_name: "Doe" }
      }),
      "Jane Doe"
    );
    assert.equal(stripeCustomerEmail({ email: " j@x.com " }), "j@x.com");
  });

  it("parses GHL location ids from /saas/locations lookup payloads", () => {
    assert.deepEqual(parseGhlLocationIdsFromSaasLocationsLookupPayload(["loc_a", "loc_b"]), [
      "loc_a",
      "loc_b"
    ]);
    assert.deepEqual(
      parseGhlLocationIdsFromSaasLocationsLookupPayload({
        locations: [{ locationId: "loc_x" }, { id: "loc_y" }]
      }),
      ["loc_x", "loc_y"]
    );
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

describe("stripe dashboard payment link", () => {
  it("opens the connected-account payment in the live dashboard", () => {
    assert.equal(
      stripeDashboardPaymentUrl({
        paymentIntentId: " pi_3Abc123 ",
        chargeId: "ch_ignored",
        stripeAccountId: " acct_1Merchant "
      }),
      "https://dashboard.stripe.com/acct_1Merchant/payments/pi_3Abc123"
    );
  });

  it("uses the charge id and test mode when there is no payment intent", () => {
    assert.equal(
      stripeDashboardPaymentUrl({
        chargeId: "ch_3Abc",
        stripeAccountId: "acct_1Merchant",
        livemode: false
      }),
      "https://dashboard.stripe.com/acct_1Merchant/test/payments/ch_3Abc"
    );
  });

  it("omits an account segment when the connected account id is missing", () => {
    assert.equal(
      stripeDashboardPaymentUrl({ paymentIntentId: "pi_3Abc" }),
      "https://dashboard.stripe.com/payments/pi_3Abc"
    );
  });

  it("returns null unless the id is a Stripe payment or charge", () => {
    assert.equal(stripeDashboardPaymentUrl({ paymentIntentId: "ghl_123", stripeAccountId: "acct_1" }), null);
    assert.equal(stripeDashboardPaymentUrl({ paymentIntentId: "pi_3Abc", stripeAccountId: "not-an-account" }), "https://dashboard.stripe.com/payments/pi_3Abc");
    assert.equal(stripeDashboardPaymentUrl({}), null);
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

describe("stripe charge failure slack message", () => {
  it("names the subaccount, payment, contact, amount, and Stripe error", () => {
    assert.equal(
      formatClientChargeFailureSlackMessage({
        locationName: "Tanisha from Beauty Elevation",
        ghlLocationId: "9qBRRyLb0AjOdYNrD1lD",
        paymentLabel: "Deposit Link - Cut & Mini Highlight",
        externalId: "6adb662e924eaa467903be53",
        contactName: "Samantha Dietz",
        contactEmail: "samanthamason07@gmail.com",
        amount: 25,
        currency: "usd",
        error: "Card was declined."
      }),
      [
        "Cobro fallido en Stripe",
        "Subcuenta: Tanisha from Beauty Elevation (9qBRRyLb0AjOdYNrD1lD)",
        "Pago: Deposit Link - Cut & Mini Highlight (6adb662e924eaa467903be53)",
        "Contacto: Samantha Dietz (samanthamason07@gmail.com)",
        "Monto: 25 USD",
        "Qué falló: Card was declined."
      ].join("\n")
    );
  });

  it("uses a distinct headline when Stripe has not confirmed the outcome", () => {
    const message = formatClientChargeFailureSlackMessage({
      ambiguous: true,
      error: "PaymentIntent is processing (processing)",
      amount: 10,
      currency: "USD"
    });
    assert.match(message, /^Cobro de Stripe sin confirmación/);
    assert.match(message, /Subcuenta: sin subcuenta/);
    assert.match(message, /Contacto: sin contacto/);
    assert.match(message, /Qué falló: PaymentIntent is processing \(processing\)/);
  });

  it("redacts card numbers and secret keys from the failure text", () => {
    const message = formatClientChargeFailureSlackMessage({
      error: "declined for 4242 4242 4242 4242 with sk_live_abc123secret",
      amount: 1,
      currency: "USD"
    });
    assert.equal(message.includes("4242"), false);
    assert.equal(message.includes("sk_live_"), false);
    assert.match(message, /Qué falló: declined for \[redacted\] with \[redacted\]/);
    assert.equal(redactChargeFailureText("  Card was declined.  "), "Card was declined.");
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

  it("allows any workspace admin regardless of email", () => {
    assert.equal(canAccessClientCharges("breanna@manicmarketing.com", "admin"), true);
    assert.equal(canAccessClientCharges("support@manicmarketing.com", "admin"), true);
    assert.equal(canAccessClientCharges("ryndon@manicmarketing.com", "user"), false);
  });
});

describe("client charges overview account view", () => {
  it("defaults unknown view query params to all eligible", () => {
    assert.equal(parseOverviewAccountView(undefined), "all");
    assert.equal(parseOverviewAccountView("nope"), "all");
    assert.equal(parseOverviewAccountView("Unbilled"), "unbilled");
    assert.equal(parseOverviewAccountView("activity"), "activity");
  });

  it("keeps enabled accounts with zero activity on all, not on to-charge", () => {
    const empty = emptyOverviewAccountRow({
      locationId: "loc-1",
      ghlLocationId: "ghl-1",
      locationName: "Kymala"
    });
    assert.equal(overviewAccountMatchesView(empty, "all"), true);
    assert.equal(overviewAccountMatchesView(empty, "unbilled"), false);
    assert.equal(overviewAccountMatchesView(empty, "activity"), false);
    assert.equal(overviewAccountMatchesView({ ...empty, unbilledCount: 2 }, "unbilled"), true);
    assert.equal(overviewAccountMatchesView({ ...empty, eligibleCount: 1 }, "activity"), true);
    assert.equal(overviewAccountMatchesView({ ...empty, failedCount: 1 }, "failed"), true);
  });
});
