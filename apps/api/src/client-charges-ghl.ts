import type { AgentFlowDb } from "@agentflow/db";

import type { GhlOAuthRefreshCredentialEnv } from "./ghl-oauth-location-token.js";
import { getAccessTokensForLocation } from "./ghl-oauth-location-token.js";

export type ClientChargeGhlEnv = GhlOAuthRefreshCredentialEnv & {
  GHL_APP_ID?: string;
  GHL_CLIENT_CHARGE_METER_ID?: string;
  GHL_CLIENT_CHARGE_ENDPOINT?: string;
};

export type WalletChargeRequest = {
  locationId: string;
  companyId: string;
  meterId?: string | null;
  eventId: string;
  description: string;
  amount: number;
  currency: string;
  eventTime: Date;
};

export type WalletChargeResult =
  | {
      ok: true;
      ambiguous: false;
      status: number;
      request: Record<string, unknown>;
      response: Record<string, unknown>;
      externalReferenceId: string | null;
      transactionId: string | null;
    }
  | {
      ok: false;
      ambiguous: boolean;
      status: number | null;
      error: string;
      request: Record<string, unknown>;
      response: Record<string, unknown>;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function responseError(status: number, payload: Record<string, unknown>, rawText: string): string {
  return (
    stringValue(payload.message, payload.error, payload.errorMessage) ??
    rawText.trim() ??
    `GHL wallet charge failed (${status})`
  );
}

/**
 * Posts one usage event to GHL Marketplace billing.
 *
 * `eventId` is the server-side idempotency/reference key required by GHL. A network/5xx outcome is marked
 * ambiguous and must not be blindly retried because the wallet may already have accepted the charge.
 */
export async function createGhlSubaccountWalletCharge(
  env: ClientChargeGhlEnv,
  db: AgentFlowDb,
  input: WalletChargeRequest
): Promise<WalletChargeResult> {
  const appId = env.GHL_APP_ID?.trim();
  const meterId = input.meterId?.trim() || env.GHL_CLIENT_CHARGE_METER_ID?.trim();
  const endpoint =
    env.GHL_CLIENT_CHARGE_ENDPOINT?.trim() ||
    `${(env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "")}/marketplace/billing/charges`;

  const request = {
    appId: appId ?? null,
    meterId: meterId ?? null,
    eventId: input.eventId,
    locationId: input.locationId,
    companyId: input.companyId,
    description: input.description,
    units: "1",
    price: input.amount,
    eventTime: input.eventTime.toISOString(),
    currency: input.currency
  };

  if (!appId) {
    return {
      ok: false,
      ambiguous: false,
      status: null,
      error: "GHL_APP_ID is not configured",
      request,
      response: {}
    };
  }
  if (!meterId) {
    return {
      ok: false,
      ambiguous: false,
      status: null,
      error: "GHL_CLIENT_CHARGE_METER_ID is not configured for this location or Worker",
      request,
      response: {}
    };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return {
      ok: false,
      ambiguous: false,
      status: null,
      error: "Charge amount must be positive",
      request,
      response: {}
    };
  }

  const tokens = await getAccessTokensForLocation(env, db, input.locationId, {
    preemptiveOAuthRefresh: true
  });
  if (tokens.length === 0) {
    return {
      ok: false,
      ambiguous: false,
      status: null,
      error: "No OAuth token is available for this GHL subaccount",
      request,
      response: {}
    };
  }

  let lastDefinitive: WalletChargeResult | null = null;
  for (const accessToken of tokens) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: "2021-07-28"
        },
        body: JSON.stringify({
          appId,
          meterId,
          eventId: input.eventId,
          locationId: input.locationId,
          companyId: input.companyId,
          description: input.description,
          units: "1",
          price: input.amount,
          eventTime: input.eventTime.toISOString()
        })
      });
      const rawText = await response.text();
      const parsed = asRecord(
        (() => {
          try {
            return JSON.parse(rawText);
          } catch {
            return {};
          }
        })()
      );

      if (response.ok) {
        const nested = asRecord(parsed.data);
        return {
          ok: true,
          ambiguous: false,
          status: response.status,
          request,
          response: parsed,
          externalReferenceId: stringValue(
            parsed.id,
            parsed.chargeId,
            nested.id,
            nested.chargeId,
            parsed.eventId,
            nested.eventId
          ),
          transactionId: stringValue(
            parsed.transactionId,
            parsed.walletTransactionId,
            nested.transactionId,
            nested.walletTransactionId
          )
        };
      }

      const failed: WalletChargeResult = {
        ok: false,
        ambiguous: response.status >= 500,
        status: response.status,
        error: responseError(response.status, parsed, rawText),
        request,
        response: parsed
      };
      if (failed.ambiguous) return failed;
      lastDefinitive = failed;

      // Authentication/scope errors may be token-specific; try the next candidate.
      if (response.status !== 401 && response.status !== 403) return failed;
    } catch (caught) {
      return {
        ok: false,
        ambiguous: true,
        status: null,
        error: caught instanceof Error ? caught.message : String(caught),
        request,
        response: {}
      };
    }
  }

  return (
    lastDefinitive ?? {
      ok: false,
      ambiguous: false,
      status: null,
      error: "All OAuth token candidates were rejected",
      request,
      response: {}
    }
  );
}
