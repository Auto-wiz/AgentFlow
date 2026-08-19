/**
 * Backfill location_billing_config from GHL SaaS catalog (all subaccounts, paginated).
 *
 * Requires admin JWT (Dashboard login) and API base URL:
 *   AGENTFLOW_API_URL=https://api.agentflow.autowiz.net
 *   AGENTFLOW_ADMIN_JWT=eyJ...
 * Optional:
 *   GHL_COMPANY_ID=e0Z1AzINaqYtX9mJe2m8  (defaults to API picking first agency)
 *   SYNC_LIMIT=8  (max rows per Worker request, 1–12; script loops until hasMore is false)
 *   START_PAGE=1
 *
 * Usage (PowerShell):
 *   $env:AGENTFLOW_ADMIN_JWT = "..."
 *   & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -c "..."  # or node:
 *   node apps/api/scripts/sync-ghl-saas-billing-catalog.mjs
 */

const apiBase = (process.env.AGENTFLOW_API_URL ?? "https://api.agentflow.autowiz.net").replace(/\/$/, "");
const token = process.env.AGENTFLOW_ADMIN_JWT?.trim();
const companyId = process.env.GHL_COMPANY_ID?.trim();

if (!token) {
  console.error("Set AGENTFLOW_ADMIN_JWT (admin session bearer token from the dashboard).");
  process.exit(1);
}

let page = Number.parseInt(process.env.START_PAGE ?? "1", 10);
if (!Number.isFinite(page) || page < 1) page = 1;
let pageOffset = 0;
const syncLimitRaw = Number.parseInt(process.env.SYNC_LIMIT ?? "8", 10);
const syncLimit = Number.isFinite(syncLimitRaw) ? Math.min(12, Math.max(1, syncLimitRaw)) : 8;

const totals = {
  pages: 0,
  processed: 0,
  syncedOk: 0,
  billingReady: 0,
  withGhlCustomerId: 0,
  withoutGhlCustomerId: 0,
  failed: 0
};

while (true) {
  const params = new URLSearchParams({
    page: String(page),
    offset: String(pageOffset),
    limit: String(syncLimit)
  });
  if (companyId) params.set("companyId", companyId);

  const res = await fetch(
    `${apiBase}/admin/client-charges/stripe/sync-saas-catalog-from-ghl?${params}`,
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

  totals.pages += 1;
  totals.processed += body.processed ?? 0;
  totals.syncedOk += body.summary?.syncedOk ?? 0;
  totals.billingReady += body.summary?.billingReady ?? 0;
  totals.withGhlCustomerId += body.summary?.withGhlCustomerId ?? 0;
  totals.withoutGhlCustomerId += body.summary?.withoutGhlCustomerId ?? 0;
  totals.failed += body.summary?.failed ?? 0;

  console.log(
    JSON.stringify(
      {
        page: body.page,
        pageOffset: body.pageOffset,
        rowsOnPage: body.rowsOnPage,
        processed: body.processed,
        summary: body.summary,
        hasMore: body.hasMore,
        nextPage: body.nextPage,
        nextPageOffset: body.nextPageOffset
      },
      null,
      2
    )
  );

  for (const row of body.results ?? []) {
    if (!row.ok) {
      console.warn(`  FAIL ${row.ghlLocationId}: ${row.code ?? ""} ${row.error ?? ""}`);
    } else if (!row.stripeCustomerMasked) {
      console.warn(`  NO_CUS ${row.ghlLocationId} ${row.locationName ?? ""}`);
    } else {
      console.log(
        `  OK ${row.ghlLocationId} ${row.stripeCustomerMasked} ready=${row.billingReady}`
      );
    }
  }

  if (!body.hasMore || body.nextPage == null) break;
  page = body.nextPage;
  pageOffset = body.nextPageOffset ?? 0;
}

console.log("\nDone.", totals);
