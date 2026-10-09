/**
 * HighLevel payment transactions linked to stored orders.
 * Order webhooks schedule a delayed lookup. Client Charges reads the rows from SQL.
 */

import { createDb, ghlPaymentOrders, ghlPaymentTransactions, locations } from "@agentflow/db";
import { and, asc, desc, eq, isNull, lte, notInArray, or, sql } from "drizzle-orm";

import {
  netCollectedMajorUnits,
  parseGhlTransactionsPayload,
  type ParsedGhlTransaction
} from "./ghl-payment-transaction-amount.js";
import {
  getAccessTokensForLocation,
  type GhlOAuthRefreshCredentialEnv
} from "./ghl-oauth-location-token.js";

export {
  COLLECTED_TRANSACTION_STATUSES,
  isCollectedTransactionStatus,
  netCollectedMajorUnits,
  parseGhlTransactionsPayload,
  transactionStatusLabel,
  type ParsedGhlTransaction
} from "./ghl-payment-transaction-amount.js";

export const ORDER_TRANSACTION_SYNC_DELAY_MS = 45_000;
export const ORDER_TRANSACTION_EMPTY_RETRY_MS = 3 * 60 * 1000;
export const ORDER_TRANSACTION_ERROR_RETRY_MS = 5 * 60 * 1000;
export const ORDER_TRANSACTION_MAX_EMPTY_ATTEMPTS = 3;
const TRANSACTION_PAGE_SIZE = 100;
const TRANSACTION_MAX_PAGES = 3;

export type OrderTransactionSyncEnv = GhlOAuthRefreshCredentialEnv & {
  DATABASE_URL: string;
};

export type OrderTransactionSyncResult = {
  ok: boolean;
  ghlOrderId: string;
  reason?: string;
  collected?: number;
  transactionCount?: number;
  synced?: boolean;
};

function parseNullableDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function listTransactionsWithToken(
  env: OrderTransactionSyncEnv,
  accessToken: string,
  ghlLocationId: string,
  ghlOrderId: string
): Promise<{ ok: true; rows: ParsedGhlTransaction[] } | { ok: false; authError: boolean; reason: string }> {
  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const rows: ParsedGhlTransaction[] = [];
  let offset = 0;

  for (let page = 0; page < TRANSACTION_MAX_PAGES; page += 1) {
    const requestUrl = new URL(`${baseUrl}/payments/transactions`);
    requestUrl.searchParams.set("altId", ghlLocationId);
    requestUrl.searchParams.set("altType", "location");
    requestUrl.searchParams.set("entityId", ghlOrderId);
    requestUrl.searchParams.set("limit", String(TRANSACTION_PAGE_SIZE));
    requestUrl.searchParams.set("offset", String(offset));

    let response: Response;
    try {
      response = await fetch(requestUrl.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Version: "2021-07-28"
        }
      });
    } catch (error) {
      return {
        ok: false,
        authError: false,
        reason: error instanceof Error ? error.message : "transaction_request_failed"
      };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, authError: true, reason: `http_${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, authError: false, reason: `http_${response.status}` };
    }

    const payload = await response.json().catch(() => null);
    const pageRows = parseGhlTransactionsPayload(payload);
    rows.push(...pageRows);
    if (pageRows.length < TRANSACTION_PAGE_SIZE) break;
    offset += pageRows.length;
  }

  return { ok: true, rows };
}

async function rescheduleOrderTransactionSync(
  db: ReturnType<typeof createDb>,
  orderId: string,
  delayMs: number
) {
  const now = new Date();
  await db
    .update(ghlPaymentOrders)
    .set({
      transactionSyncAfter: new Date(now.getTime() + delayMs),
      updatedAt: now
    })
    .where(eq(ghlPaymentOrders.id, orderId));
}

export async function syncOrderTransactionsFromGhl(
  env: OrderTransactionSyncEnv,
  params: { ghlLocationId: string; ghlOrderId: string }
): Promise<OrderTransactionSyncResult> {
  const db = createDb(env.DATABASE_URL);
  const ghlLocationId = params.ghlLocationId.trim();
  const ghlOrderId = params.ghlOrderId.trim();
  const [order] = await db
    .select({
      id: ghlPaymentOrders.id,
      locationId: ghlPaymentOrders.locationId,
      transactionSyncAttempts: ghlPaymentOrders.transactionSyncAttempts
    })
    .from(ghlPaymentOrders)
    .innerJoin(locations, eq(locations.id, ghlPaymentOrders.locationId))
    .where(and(eq(locations.ghlLocationId, ghlLocationId), eq(ghlPaymentOrders.ghlOrderId, ghlOrderId)))
    .limit(1);

  if (!order) {
    return { ok: false, ghlOrderId, reason: "order_not_found" };
  }

  const tokens = await getAccessTokensForLocation(env, db, ghlLocationId, {
    preemptiveOAuthRefresh: true
  });
  if (tokens.length === 0) {
    await rescheduleOrderTransactionSync(db, order.id, ORDER_TRANSACTION_ERROR_RETRY_MS);
    console.warn("[order.transactions.no_token]", ghlLocationId, ghlOrderId);
    return { ok: false, ghlOrderId, reason: "no_token" };
  }

  let listed: Awaited<ReturnType<typeof listTransactionsWithToken>> | null = null;
  for (const token of tokens.slice(0, 3)) {
    listed = await listTransactionsWithToken(env, token, ghlLocationId, ghlOrderId);
    if (listed.ok || !listed.authError) break;
  }

  if (!listed?.ok) {
    await rescheduleOrderTransactionSync(db, order.id, ORDER_TRANSACTION_ERROR_RETRY_MS);
    console.warn("[order.transactions.lookup_failed]", ghlOrderId, listed?.reason ?? "request_failed");
    return { ok: false, ghlOrderId, reason: listed?.reason ?? "request_failed" };
  }

  const now = new Date();
  const ids = listed.rows.map((row) => row.ghlTransactionId);
  if (listed.rows.length > 0) {
    await db
      .insert(ghlPaymentTransactions)
      .values(
        listed.rows.map((row) => ({
          locationId: order.locationId,
          orderId: order.id,
          ghlTransactionId: row.ghlTransactionId,
          status: row.status,
          amount: row.amount,
          amountRefunded: row.amountRefunded,
          currency: row.currency,
          entityId: row.entityId,
          entityType: row.entityType,
          ghlCreatedAt: parseNullableDate(row.ghlCreatedAt),
          ghlUpdatedAt: parseNullableDate(row.ghlUpdatedAt),
          raw: row.raw,
          updatedAt: now
        }))
      )
      .onConflictDoUpdate({
        target: [ghlPaymentTransactions.locationId, ghlPaymentTransactions.ghlTransactionId],
        set: {
          orderId: order.id,
          status: sql`excluded.status`,
          amount: sql`excluded.amount`,
          amountRefunded: sql`excluded.amount_refunded`,
          currency: sql`excluded.currency`,
          entityId: sql`excluded.entity_id`,
          entityType: sql`excluded.entity_type`,
          ghlCreatedAt: sql`excluded.ghl_created_at`,
          ghlUpdatedAt: sql`excluded.ghl_updated_at`,
          raw: sql`excluded.raw`,
          updatedAt: now
        }
      });
  }

  await db
    .delete(ghlPaymentTransactions)
    .where(
      ids.length === 0
        ? eq(ghlPaymentTransactions.orderId, order.id)
        : and(eq(ghlPaymentTransactions.orderId, order.id), notInArray(ghlPaymentTransactions.ghlTransactionId, ids))
    );

  const collected = netCollectedMajorUnits(listed.rows);
  const attempts = order.transactionSyncAttempts + 1;
  const synced = collected > 0 || attempts >= ORDER_TRANSACTION_MAX_EMPTY_ATTEMPTS;
  await db
    .update(ghlPaymentOrders)
    .set({
      transactionSyncAttempts: attempts,
      transactionSyncedAt: synced ? now : null,
      transactionSyncAfter: synced ? null : new Date(now.getTime() + ORDER_TRANSACTION_EMPTY_RETRY_MS),
      updatedAt: now
    })
    .where(eq(ghlPaymentOrders.id, order.id));

  return {
    ok: true,
    ghlOrderId,
    collected,
    transactionCount: listed.rows.length,
    synced
  };
}

export function scheduleOrderTransactionSync(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  env: OrderTransactionSyncEnv,
  params: { ghlLocationId: string; ghlOrderId: string }
) {
  const run = (async () => {
    await new Promise((resolve) => setTimeout(resolve, ORDER_TRANSACTION_SYNC_DELAY_MS));
    await syncOrderTransactionsFromGhl(env, params);
  })().catch((error) => {
    console.warn("[order.transactions.scheduled.failed]", params.ghlOrderId, error);
  });
  ctx.waitUntil(run);
}

export async function syncDueOrderTransactions(env: OrderTransactionSyncEnv, limit = 4) {
  const db = createDb(env.DATABASE_URL);
  const due = await db
    .select({
      ghlOrderId: ghlPaymentOrders.ghlOrderId,
      ghlLocationId: locations.ghlLocationId
    })
    .from(ghlPaymentOrders)
    .innerJoin(locations, eq(locations.id, ghlPaymentOrders.locationId))
    .where(
      and(
        isNull(ghlPaymentOrders.transactionSyncedAt),
        eq(ghlPaymentOrders.isDeleted, false),
        or(isNull(ghlPaymentOrders.transactionSyncAfter), lte(ghlPaymentOrders.transactionSyncAfter, new Date()))
      )
    )
    .orderBy(
      sql`(${ghlPaymentOrders.transactionSyncAfter} is null) asc`,
      sql`(
        lower(coalesce(${ghlPaymentOrders.raw}->'source'->>'type', '')) = 'calendar'
        or strpos(lower(coalesce(${ghlPaymentOrders.altType}, '')), 'appointment') > 0
      ) desc`,
      asc(ghlPaymentOrders.transactionSyncAfter),
      desc(ghlPaymentOrders.updatedAt)
    )
    .limit(limit);

  const results: OrderTransactionSyncResult[] = [];
  for (const row of due) {
    try {
      results.push(await syncOrderTransactionsFromGhl(env, row));
    } catch (error) {
      console.warn("[order.transactions.cron.failed]", row.ghlOrderId, error);
      results.push({
        ok: false,
        ghlOrderId: row.ghlOrderId,
        reason: error instanceof Error ? error.message : "sync_failed"
      });
    }
  }
  return { checked: due.length, results };
}
