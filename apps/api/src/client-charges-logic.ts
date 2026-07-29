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
