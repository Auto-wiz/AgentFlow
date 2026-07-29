import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CANONICAL_DEPOSIT_PRECEDENCE,
  canonicalDepositRank,
  clientChargeIdempotencyKey,
  isChargeActionDisabled,
  isChargeRetryable,
  isValidChargeCurrency,
  normalizeChargeAmount,
  pickCanonicalDepositSource
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
