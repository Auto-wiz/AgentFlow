import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isCollectedTransactionStatus,
  netCollectedMajorUnits,
  parseGhlTransactionsPayload,
  transactionStatusLabel,
  type ParsedGhlTransaction
} from "./ghl-payment-transaction-amount.ts";

function txn(partial: Partial<ParsedGhlTransaction> & Pick<ParsedGhlTransaction, "ghlTransactionId">): ParsedGhlTransaction {
  return {
    status: null,
    amount: null,
    amountRefunded: null,
    currency: null,
    entityId: null,
    entityType: null,
    ghlCreatedAt: null,
    ghlUpdatedAt: null,
    raw: {},
    ...partial
  };
}

describe("transaction payload parsing", () => {
  it("reads data[], transactions[], or a bare array", () => {
    const row = {
      _id: "txn_1",
      amount: 25,
      amountRefunded: 0,
      currency: "USD",
      entityId: "order_1",
      entityType: "order",
      status: "succeeded",
      createdAt: "2026-10-07T03:44:35.000Z",
      updatedAt: "2026-10-07T03:44:40.000Z"
    };
    assert.equal(parseGhlTransactionsPayload({ data: [row] })[0]?.ghlTransactionId, "txn_1");
    assert.equal(parseGhlTransactionsPayload({ transactions: [{ id: "txn_2", amount: "10.4" }] })[0]?.amount, 10);
    assert.equal(parseGhlTransactionsPayload([row]).length, 1);
  });

  it("accepts status as a string or an object and skips rows without an id", () => {
    assert.equal(transactionStatusLabel(" Paid "), "Paid");
    assert.equal(transactionStatusLabel({ status: "Succeeded" }), "Succeeded");
    assert.equal(transactionStatusLabel({ value: "completed" }), "completed");
    assert.equal(transactionStatusLabel({ name: "complete" }), "complete");
    assert.equal(transactionStatusLabel(null), null);
    const parsed = parseGhlTransactionsPayload({
      data: [{ amount: 25 }, { _id: "txn_3", status: { status: "successful" }, amount_refunded: 5, amount: 25 }]
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.status, "successful");
    assert.equal(parsed[0]?.amountRefunded, 5);
  });
});

describe("collected transaction amount", () => {
  it("sums succeeded money and ignores unpaid or non-collected statuses", () => {
    assert.equal(isCollectedTransactionStatus("Succeeded"), true);
    assert.equal(isCollectedTransactionStatus("pending"), false);
    const total = netCollectedMajorUnits([
      txn({ ghlTransactionId: "a", status: "succeeded", amount: 25, amountRefunded: 0 }),
      txn({ ghlTransactionId: "b", status: "paid", amount: 40, amountRefunded: 10 }),
      txn({ ghlTransactionId: "c", status: "pending", amount: 100 }),
      txn({ ghlTransactionId: "d", status: "failed", amount: 15 }),
      txn({ ghlTransactionId: "e", status: "succeeded", amount: 0 })
    ]);
    assert.equal(total, 55);
  });

  it("clamps a refund larger than the charge to zero", () => {
    assert.equal(
      netCollectedMajorUnits([txn({ ghlTransactionId: "r", status: "completed", amount: 20, amountRefunded: 35 })]),
      0
    );
  });
});
