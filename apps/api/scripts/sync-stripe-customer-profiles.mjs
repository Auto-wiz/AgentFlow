/**
 * Refresh stripe_customer_name / email from Stripe for rows that already have cus_.
 *
 *   AGENTFLOW_ADMIN_JWT=...
 *   node apps/api/scripts/sync-stripe-customer-profiles.mjs
 */

const apiBase = (process.env.AGENTFLOW_API_URL ?? "https://api.agentflow.autowiz.net").replace(/\/$/, "");
const token = process.env.AGENTFLOW_ADMIN_JWT?.trim();

if (!token) {
  console.error("Set AGENTFLOW_ADMIN_JWT.");
  process.exit(1);
}

const totals = { batches: 0, processed: 0, refreshedOk: 0, failed: 0 };
let after = (process.env.START_AFTER ?? "").trim() || null;

while (true) {
  const params = new URLSearchParams({ limit: "10" });
  if (after) params.set("after", after);

  const res = await fetch(
    `${apiBase}/admin/client-charges/stripe/refresh-customer-profiles?${params}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Request failed", res.status, body);
    process.exit(1);
  }

  totals.batches += 1;
  totals.processed += body.processed ?? 0;
  totals.refreshedOk += body.summary?.refreshedOk ?? 0;
  totals.failed += body.summary?.failed ?? 0;

  console.log(JSON.stringify({ summary: body.summary, hasMore: body.hasMore }, null, 2));
  for (const row of body.results ?? []) {
    if (row.ok) {
      console.log(`  OK ${row.ghlLocationId} ${row.customerName ?? row.customerEmail ?? "?"}`);
    } else {
      console.warn(`  FAIL ${row.ghlLocationId}: ${row.code} ${row.error}`);
    }
  }

  if (!body.hasMore || !body.nextAfterLocationId) break;
  after = body.nextAfterLocationId;
}

console.log("\nDone.", totals);
