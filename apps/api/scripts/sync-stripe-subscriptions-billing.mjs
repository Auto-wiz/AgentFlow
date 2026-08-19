/**
 * Link subaccounts from platform Stripe active subscriptions (source of truth for cus_).
 *
 * Requires admin JWT:
 *   AGENTFLOW_API_URL=https://api.agentflow.autowiz.net
 *   AGENTFLOW_ADMIN_JWT=eyJ...
 * Optional:
 *   GHL_COMPANY_ID=e0Z1AzINaqYtX9mJe2m8
 *   SYNC_LIMIT=8  (1–10 subscriptions per Worker request)
 *
 * Usage:
 *   node apps/api/scripts/sync-stripe-subscriptions-billing.mjs
 */

const apiBase = (process.env.AGENTFLOW_API_URL ?? "https://api.agentflow.autowiz.net").replace(/\/$/, "");
const token = process.env.AGENTFLOW_ADMIN_JWT?.trim();
const companyId = process.env.GHL_COMPANY_ID?.trim();

if (!token) {
  console.error("Set AGENTFLOW_ADMIN_JWT (admin session bearer token from the dashboard).");
  process.exit(1);
}

const syncLimitRaw = Number.parseInt(process.env.SYNC_LIMIT ?? "8", 10);
const syncLimit = Number.isFinite(syncLimitRaw) ? Math.min(10, Math.max(1, syncLimitRaw)) : 8;

const totals = {
  batches: 0,
  processed: 0,
  linkedOk: 0,
  billingReady: 0,
  skippedNoMetadata: 0,
  failed: 0
};

let startingAfter = (process.env.STARTING_AFTER ?? "").trim() || null;

while (true) {
  const params = new URLSearchParams({ limit: String(syncLimit) });
  if (companyId) params.set("companyId", companyId);
  if (startingAfter) params.set("starting_after", startingAfter);

  const res = await fetch(
    `${apiBase}/admin/client-charges/stripe/sync-from-stripe-subscriptions?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    }
  );

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Request failed", res.status, body);
    process.exit(1);
  }

  totals.batches += 1;
  totals.processed += body.processed ?? 0;
  totals.linkedOk += body.summary?.linkedOk ?? 0;
  totals.billingReady += body.summary?.billingReady ?? 0;
  totals.skippedNoMetadata += body.summary?.skipped ?? 0;
  totals.failed += body.summary?.failed ?? 0;

  console.log(
    JSON.stringify(
      {
        processed: body.processed,
        summary: body.summary,
        hasMore: body.hasMore,
        nextStartingAfter: body.nextStartingAfter
      },
      null,
      2
    )
  );

  for (const row of body.results ?? []) {
    if (!row.ok) {
      console.warn(
        `  FAIL ${row.subscriptionId} ${row.ghlLocationId ?? "?"}: ${row.code ?? ""} ${row.error ?? ""}`
      );
    } else {
      console.log(
        `  OK ${row.ghlLocationId} ${row.stripeCustomerMasked} ready=${row.billingReady}`
      );
    }
  }

  if (!body.hasMore || !body.nextStartingAfter) break;
  startingAfter = body.nextStartingAfter;
}

console.log("\nDone.", totals);
