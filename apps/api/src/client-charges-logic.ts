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

/** Stripe Customer ids use the cus_ prefix (platform or Connect context). */
export function normalizeStripeCustomerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (/^cus_[A-Za-z0-9]+$/.test(id)) return id;
  return null;
}

export function isValidStripeCustomerId(raw: unknown): boolean {
  return normalizeStripeCustomerId(raw) != null;
}

export type ClientChargesChargingEnv = {
  CLIENT_CHARGES_CHARGING_ENABLED?: string;
};

/** Live charges require explicit opt-in via Worker var (sync/billing setup stay available). */
export function isClientChargesChargingEnabled(env: ClientChargesChargingEnv): boolean {
  const v = env.CLIENT_CHARGES_CHARGING_ENABLED?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Safe structural summary when GHL does not publish a response schema (no secret values). */
export function summarizeUnknownJsonShape(
  value: unknown,
  depth = 0,
  maxDepth = 5,
  maxKeys = 12
): unknown {
  if (depth >= maxDepth) return "…";
  if (value == null) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^cus_[A-Za-z0-9]+$/.test(trimmed)) return "string(cus_…)";
    if (/^acct_[A-Za-z0-9]+$/.test(trimmed)) return "string(acct_…)";
    if (trimmed.length > 64) return "string(…)";
    return "string";
  }
  if (typeof value === "number" || typeof value === "boolean") return typeof value;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [summarizeUnknownJsonShape(value[0], depth + 1, maxDepth, maxKeys)];
  }
  if (typeof value !== "object") return typeof value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).slice(0, maxKeys)) {
    out[key] = summarizeUnknownJsonShape(obj[key], depth + 1, maxDepth, maxKeys);
  }
  const extra = Object.keys(obj).length - maxKeys;
  if (extra > 0) out["…"] = `+${extra} keys`;
  return out;
}

const SAAS_STRIPE_CUSTOMER_FIELD_KEYS = [
  "customerId",
  "customer_id",
  "CustomerId",
  "stripeCustomerId",
  "stripe_customer_id",
  "stripeCustomer",
  "stripe_customer",
  "billingCustomerId",
  "billing_customer_id",
  "saasCustomerId",
  "saas_customer_id"
] as const;

function stripeCustomerFromNestedCustomerObject(value: unknown): string | null {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!obj) return null;
  for (const key of ["id", "customerId", "customer_id", "stripeCustomerId", "stripe_customer_id"]) {
    const normalized = normalizeStripeCustomerId(obj[key]);
    if (normalized) return normalized;
  }
  return null;
}

export function extractSaasSubscriptionStripeCustomerId(payload: unknown): string | null {
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 8 || value == null) return null;
    if (typeof value === "string") {
      return normalizeStripeCustomerId(value);
    }
    if (typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const obj = value as Record<string, unknown>;
    for (const key of SAAS_STRIPE_CUSTOMER_FIELD_KEYS) {
      const normalized = normalizeStripeCustomerId(obj[key]);
      if (normalized) return normalized;
    }
    for (const key of ["customer", "stripe", "billing", "paymentProvider", "payment_provider"]) {
      const fromNested = stripeCustomerFromNestedCustomerObject(obj[key]);
      if (fromNested) return fromNested;
    }
    for (const nested of [
      obj.data,
      obj.subscription,
      obj.saasSubscription,
      obj.saas_subscription,
      obj.saas,
      obj.payload,
      obj.result,
      obj.subscriptionDetails,
      obj.subscription_details
    ]) {
      const found = visit(nested, depth + 1);
      if (found) return found;
    }
    for (const child of Object.values(obj)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(payload, 0);
}

function saasRowGhlLocationId(row: Record<string, unknown>): string | null {
  for (const key of ["locationId", "location_id", "id"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Pick one SaaS location row from GET /saas/saas-locations/:companyId (v3) list payloads. */
export function findGhlSaasLocationRecord(
  payload: unknown,
  ghlLocationId: string
): Record<string, unknown> | null {
  const target = ghlLocationId.trim();
  if (!target) return null;

  const scanArray = (arr: unknown[]): Record<string, unknown> | null => {
    for (const item of arr) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (saasRowGhlLocationId(row) === target) return row;
    }
    return null;
  };

  const visit = (value: unknown, depth: number): Record<string, unknown> | null => {
    if (depth > 6 || value == null) return null;
    if (Array.isArray(value)) return scanArray(value);
    if (typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    if (saasRowGhlLocationId(obj) === target) return obj;
    for (const key of ["locations", "saasLocations", "data", "items", "results"]) {
      const nested = obj[key];
      if (Array.isArray(nested)) {
        const found = scanArray(nested);
        if (found) return found;
      }
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const found = visit(nested, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return visit(payload, 0);
}

/** True when a v3 saas-locations page has no rows (end of pagination). */
export function isEmptySaasLocationsPage(payload: unknown): boolean {
  const row = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!row) return true;
  for (const key of ["locations", "saasLocations", "data", "items", "results"]) {
    const nested = row[key];
    if (Array.isArray(nested)) return nested.length === 0;
  }
  if (Array.isArray(payload)) return payload.length === 0;
  return false;
}

export function pickDefaultPaymentMethodIdFromStripeCustomer(
  customer: {
    invoice_settings?: { default_payment_method?: string | { id?: string } | null } | null;
  },
  paymentMethodIds: string[]
): string | null {
  const raw = customer.invoice_settings?.default_payment_method;
  const fromSettings =
    typeof raw === "string"
      ? raw.trim()
      : raw && typeof raw === "object" && typeof raw.id === "string"
        ? raw.id.trim()
        : "";
  if (fromSettings.startsWith("pm_")) return fromSettings;
  if (paymentMethodIds.length === 1) return paymentMethodIds[0] ?? null;
  return null;
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
