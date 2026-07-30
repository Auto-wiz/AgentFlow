/**
 * Pure helpers for Client Charges — kept separate from SQL/GHL I/O for unit testing.
 */

export type CanonicalDepositKind = "payment_order" | "invoice";
export type CanonicalMatchedBy =
  | "direct_appointment_order"
  | "correlated_order"
  | "correlated_invoice";

/** Confirmed precedence: lower rank wins; never sum order+invoice mirrors. */
export const CANONICAL_DEPOSIT_PRECEDENCE: readonly CanonicalMatchedBy[] = [
  "direct_appointment_order",
  "correlated_order",
  "correlated_invoice"
] as const;

export function canonicalDepositRank(matchedBy: CanonicalMatchedBy): number {
  const idx = CANONICAL_DEPOSIT_PRECEDENCE.indexOf(matchedBy);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

export function pickCanonicalDepositSource<T extends { matchedBy: CanonicalMatchedBy }>(
  candidates: T[]
): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => canonicalDepositRank(a.matchedBy) - canonicalDepositRank(b.matchedBy)
  )[0]!;
}

export function normalizeChargeAmount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n);
  return rounded > 0 ? rounded : null;
}

export function isValidChargeCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value.trim());
}

export function isChargeRetryable(status: string | null | undefined): boolean {
  return (status ?? "").toLowerCase() === "failed";
}

export function isChargeActionDisabled(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "succeeded" || s === "pending";
}

export function clientChargeIdempotencyKey(appointmentId: string): string {
  return `agentflow-result-${appointmentId.trim()}`;
}

/** Stripe Connect account ids use the acct_ prefix. */
export function normalizeStripeConnectAccountId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!/^acct_[A-Za-z0-9]+$/.test(id)) return null;
  return id;
}

export function isValidStripeConnectAccountId(raw: unknown): boolean {
  return normalizeStripeConnectAccountId(raw) != null;
}

/** Stripe SDK request options for direct charges on a connected account. */
export function stripeConnectedChargeRequestOptions(connectedAccountId: string, idempotencyKey: string) {
  return {
    stripeAccount: connectedAccountId.trim(),
    idempotencyKey: idempotencyKey.slice(0, 255)
  };
}

/** Ledger amounts are major currency units (e.g. USD dollars). Stripe expects minor units. */
const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

export function toStripeMinorUnits(majorAmount: number, currency: string): number | null {
  if (!Number.isFinite(majorAmount) || majorAmount <= 0) return null;
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return Math.round(majorAmount);
  }
  return Math.round(majorAmount * 100);
}

export function mapStripeChargeErrorMessage(code: string | undefined, message: string | undefined): string {
  const c = (code ?? "").toLowerCase();
  if (c === "authentication_required") {
    return "Card requires authentication — add or update the payment method for this subaccount.";
  }
  if (c === "card_declined") {
    return message?.trim() || "Card was declined.";
  }
  if (c === "insufficient_funds") {
    return "Insufficient funds on the saved payment method.";
  }
  return message?.trim() || code?.trim() || "Stripe charge failed";
}

export function isStripeChargeAmbiguousHttpStatus(status: number | undefined): boolean {
  return status == null || status >= 500;
}
