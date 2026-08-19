# AgentFlow

MVP foundation for a centralized GoHighLevel agency inbox. AgentFlow mirrors
SMS and email activity from all subaccounts through webhooks, keeps a
channel-agnostic thread per contact, and exposes pending replies across the
agency. Calls are explicitly out of scope for this foundation.

## Stack

- Cloudflare Workers + Hono for the API and webhook entrypoint
- Cloudflare Queues with the consumer exported from the same Worker
- Neon Postgres through Drizzle ORM using the HTTP driver
- Next.js 14 App Router for the Cloudflare Pages frontend
- TypeScript across the monorepo with npm workspaces

## Workspaces

- `apps/api` - Worker API, webhook receiver, and Queue consumer
- `apps/web` - Next.js App Router frontend
- `packages/db` - Drizzle schema and Neon client helpers
- `packages/shared` - shared webhook and API types

## Environment

Copy `.env.example` for local development. Do not commit real secrets.

### Workspace UI authentication

The **web app** always requires a stored workspace JWT: unauthenticated users are sent to `/login` and the UI never falls back to anonymous “guest” or `x-viewer-key` from the browser.

The **API** can still accept `x-viewer-key` when `JWT_SECRET` is **not** set (for other clients or tools). Configure `JWT_SECRET` for normal production use.

Frontend variables:

```txt
NEXT_PUBLIC_API_BASE_URL=…
```

### Database migrations (Drizzle)

Apply schema with **`npm run db:migrate --workspace @agentflow/db`** after **`$env:DATABASE_URL`** (PowerShell). The repo ships **`packages/db/migrations/meta/_journal.json`** so `drizzle-kit migrate` knows the ordered `*.sql` files.

If `drizzle-kit migrate` exits with **code 1** but you don’t see a SQL error, run **`npm run db:migrate:apply --workspace @agentflow/db`** (same `DATABASE_URL`). It applies the same files via **`pg`** and prints the full Postgres error message.

When the schema **already matches** the repo but **`drizzle.__drizzle_migrations`** is missing rows (you keep hitting **`already exists`**), run **`npm run db:migrate:baseline-log --workspace @agentflow/db`** once to register every journal entry that isn’t there yet. Preview with **`db:migrate:baseline-log:dry`**. **Only use this if the DB really has all migration DDL**—otherwise Drizzle will skip missing SQL and the app will break. Then run **`db:migrate:apply`** again.

PostgreSQL **`pg`/Node** may warn that `sslmode=require` will change meaning in future `pg` majors; Neon suggests moving to **`sslmode=verify-full`** (see warning text) when you rotate URLs.

Executed migrations are tracked in **`drizzle.__drizzle_migrations`** (default Drizzle Kit schema/table).

If Postgres was only **partially** migrated manually, fix objects in Neon’s SQL Editor or reconcile rows by hand; **`baseline-log`** is not for empty DBs.

With `JWT_SECRET` set on the Worker, users **sign in at `/login`** with **email and password** (`POST /auth/login`). Create `workspace_users` rows in Postgres (email, bcrypt `password_hash`, role, etc.); the API uses the same bcrypt cost as `apps/api/src/auth-lib.ts` (`hashPassword`).

**GoHighLevel OAuth** on the Worker stores installation tokens when an admin connects from **Settings → Connect GoHighLevel**. It does **not** create workspace users or replace your login session — use **email/password** (admin-provisioned accounts) to sign in.

OAuth remains scoped to the **same HighLevel agency** already in your database: `agencies.ghl_agency_id` and/or `ghl_oauth_installations.company_id`. If both are empty, the **first** successful OAuth defines the tenant; later flows must use that same agency company id (otherwise the callback returns `wrong_agency` and redirects to login with that error).

Configure **Settings → Workspace admin** to choose default picked locations (`role=user`), and **Settings → Team selections** read-only overview of selections across everyone.

**Troubleshooting OAuth (XML `Generation` / `InvalidArgument`):** that response is from **Google Cloud Storage**, not HighLevel. It almost always means `NEXT_PUBLIC_API_BASE_URL` on the Pages build points at a **storage bucket**, the **Pages** hostname, or another non-API host. The OAuth buttons must call your **Worker** origin (`https://…workers.dev` or custom API domain) so `/oauth/gohighlevel/start` runs on the Worker and redirects to Marketplace.

Production secrets are configured through Wrangler:

```sh
wrangler secret put DATABASE_URL
wrangler secret put GHL_WEBHOOK_SECRET
wrangler secret put GHL_API_TOKEN
wrangler secret put GHL_CLIENT_ID
wrangler secret put GHL_CLIENT_SECRET
wrangler secret put JWT_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

Set these Worker variables in the Cloudflare dashboard or as `[vars]` in
`apps/api/wrangler.toml` for OAuth/install routing:

```txt
GHL_OAUTH_START_URL (recommended — Installation URL from portal)
GHL_INSTALL_URL (fallback if GHL_OAUTH_START_URL unset)
GHL_APP_ID (optional)
GHL_OAUTH_REDIRECT_URI
GHL_OAUTH_USER_TYPE
FRONTEND_BASE_URL
```

GoHighLevel OAuth redirect URL:

```txt
https://api.agentflow.autowiz.net/oauth/gohighlevel/callback
```

GoHighLevel default webhook URL:

```txt
https://api.agentflow.autowiz.net/webhooks/gohighlevel
```

Enable these webhook events:

```txt
INSTALL
InboundMessage
OutboundMessage
AppointmentCreate
AppointmentUpdate
AppointmentDelete
InvoiceCreate
InvoiceUpdate
InvoiceSent
InvoicePaid
InvoicePartiallyPaid
InvoiceVoid
InvoiceDelete
OrderCreate
OrderStatusUpdate
```

Appointment **paid/unpaid** in the API blends **invoices** and **payment orders** (`ghl_payment_orders`): same contact and location window as invoices where possible; when an order exposes `altId`/`altType` pointing at an appointment, that counts without the time overlap.

Install flow entrypoint:

```txt
https://api.agentflow.autowiz.net/oauth/gohighlevel/start
```

## Location display names (subaccounts)

Bulk OAuth often creates **`locations`** rows before HighLevel payloads include a readable name. Names are persisted when:

1. **`LocationUpdate`/`Contact`/`Appointment`/`Message` webhooks** carry `event.location.name` (upsert uses `COALESCE` — first non-empty sticks). HighLevel does not always emit renames, so long-lived rows can drift.
2. **`POST /admin/locations/hydrate-missing-names?limit=N`** (admin JWT) sequentially fetches from GHL and updates blank names. **`limit` is capped at 10** — repeat until **`backlogRemaining`** reaches **`0`** (or **`null`** briefly: see **`rerunHint`** if the backlog tally hit subrequest limits). Every Cloudflare **`fetch`/`Subrequest`** counts (Neon over HTTP + GHL APIs). `[limits] subrequests` in **`wrangler.toml` is not compatible with the Workers Free plan** (deploy fails with CPU/limits API error `100328`). This repo **omits `[limits]`** so Git-connected builds succeed on Free; you still get the platform default subrequest ceiling (~50 on Free). On a **paid Workers plan**, raise subrequests in the **Worker → Settings → CPU / Limits** (or restore a `[limits]` block if your plan supports it — see Cloudflare docs). **Workers Free** still caps external subrequests tightly; use small hydrate batches, cron, or upgrade for large backfills.
3. **`GET /subaccounts/overview?surface=all`** budgets on-demand lookups per request (heavy lists still need (1)/(2)).
4. **Stale display-name refresh** (after migration `0010_location_name_synced_at`): each successful GHL hydrate records `locations.location_name_synced_at`. Set **`LOCATION_NAMES_REFRESH_BATCH`** > 0 so the Worker `scheduled` handler periodically re-queries GHL for locations whose name is already non-empty but last sync exceeds **`LOCATION_NAMES_REFRESH_STALE_AFTER_DAYS`** (defaults to **2**). Cap per tick is **15** lookups (`Math.min(parsed,15)`); use **`LOCATION_NAMES_REFRESH_HOUR_UTC`** (0–23) to confine refreshes to a single UTC clock hour (“morning window”). **`POST /admin/locations/refresh-stale-names?limit=N`** triggers the same path manually.

To **eventually drain a large backlog** of blank names without manual looping, configure **`LOCATION_NAME_CRON_BATCH`** > 0 — each cron tick processes up to **15** unnamed locations (batched hydrate; cap matches `scheduled` handler).

## Appointment overrides & workspace audit

Apply migration **`0011_appointment_overrides_and_audit_logs`**.

1. **`PUT /workspace/appointments/:id/overrides`** (workspace JWT — same location access rules as **`GET /appointments`**) persists `{ manualPaymentOverride: inherit | force_paid | force_unpaid, hiddenFromUi }` on **`appointments`**. Overrides change list filtering **`paymentStatus`** and let users hide bookings from default lists (**`hidden_from_ui`**).
2. **`GET /appointments`** exposes those fields plus query **`hidden=`** **`omit`** (default, drops hidden rows) | **`include`** | **`only`** for recovery workflows.
3. **`GET /admin/workspace-audit-logs`** returns recent **`workspace_audit_logs`** (`from` / `to` ISO timestamps, **`actionKind`**, **`locationId`**, **`actorWorkspaceUserId`**, **`limit`**). Rows are capped to the trailing **90**-day retention window enforced by **`pruneWorkspaceAuditLogs`** inside the Worker `scheduled` handler.
4. Audit rows are written today for overrides, provisioning users, admin sub-account seeds, personal picker saves, and legacy viewer-key **`POST /subaccounts/visibility`**.

Appointment counts shown on **`/subaccounts/overview?surface=appointments`** omit hidden-only tallies (**`WHERE hidden_from_ui = false`**).

## Client Charges (Stripe)

Pay-per-result billing uses **one platform Stripe account** (`STRIPE_SECRET_KEY`). Each GHL subaccount needs a **`cus_…`** (SaaS billing customer) and usually a saved card before charges run on the platform account. **Connect (`acct_…`)** is optional legacy path if you still charge on connected accounts.

1. Apply migrations through **`0016_stripe_account_id_unique`** (includes **`0015_stripe_connect_billing`**).
2. Worker secrets: **`STRIPE_SECRET_KEY`**, **`STRIPE_WEBHOOK_SECRET`**. Var: **`FRONTEND_BASE_URL`** (Checkout return URLs).
3. Stripe Dashboard webhook on the **platform** account: **`https://api.agentflow.autowiz.net/webhooks/stripe`**. Events: **`checkout.session.completed`**, **`setup_intent.succeeded`**, **`payment_intent.succeeded`**, **`payment_intent.payment_failed`** (plus Connect **`account.updated`** if you use **`acct_…`**).
4. **GHL SaaS customer sync:** requires **SaaS Configurator** access on the agency. OAuth scopes **`saas/location.read`** / **`saas/location.write`**, reconnect from Settings after publishing a new app version. Primary API: **`GET /saas/saas-locations/:companyId?page=1`** with header **`Version: v3`**, then match the subaccount `locationId` and read Stripe **`customerId`**. Fallback: legacy **`GET /saas/get-saas-subscription/:locationId?companyId=…`**. Admin endpoints:
   - **`POST /admin/client-charges/locations/:locationId/stripe/sync-from-ghl`**
   - **`POST /admin/client-charges/stripe/sync-from-ghl-all?limit=5`** (capped per request to stay within Cloudflare Worker subrequest limits; run again for more subaccounts)
   - **`POST /admin/client-charges/stripe/sync-saas-catalog-from-ghl?page=1&companyId=…&limit=8`** — lists **all** GHL SaaS subaccounts via `GET /saas/saas-locations/:companyId` (v3), upserts `locations` + `location_billing_config`, and applies `cus_…` when present. Repeat with `page=2…` until `hasMore` is false. Local script: `node apps/api/scripts/sync-ghl-saas-billing-catalog.mjs` (needs `AGENTFLOW_ADMIN_JWT`).
   - **`PATCH /admin/client-charges/locations/:locationId/stripe/customer-link`** with `{ "stripeCustomerId": "cus_…" }` to verify manually.
   If sync returns **`customer_id_missing`**, the response includes **`payloadShape`** (keys/types only, no secrets) so the parser can be extended.
5. **Automatic sync:** GHL webhooks **`SaaSPlanCreate`**, **`LocationCreate`**, and SaaS location/plan events (`saaslocation*`, `planchange`, etc.) queue a job that upserts the location, ensures a **`location_billing_config`** row, and syncs **`cus_…`** from the webhook payload or GHL SaaS API when **`STRIPE_SECRET_KEY`** is set. Skips when billing is already **ready** (`cus_` + payment method). Manual sync and catalog backfill endpoints remain available.
6. In the app: **Dashboard → Client Charges → Pay per Use Model Eligibility** → **Sync from GHL** or paste **`cus_…`** → **Verify customer** → **Add payment method** → enable the subaccount.
7. **Live charges are opt-in:** Worker var **`CLIENT_CHARGES_CHARGING_ENABLED`** must be **`true`** before **`POST /workspace/client-charges/:appointmentId/charge`** or **retry** will run Stripe PaymentIntents. Default in `wrangler.toml` is **`false`** (sync, customer link, and Checkout setup still work).

## Validation

```sh
npm run check
npm run build
```

For the Cloudflare Pages artifact, run:

```sh
npm run pages:build -w @agentflow/web
```

## API Worker deploy (automatic from Git)

Production API (`https://api.agentflow.autowiz.net`) is Worker **`agenflow-back`** (`apps/api`).

### Cloudflare Workers Builds (production deploy)

**Stripe webhooks** (`/webhooks/stripe`) and the REST API are **`agenflow-back`** (`apps/api`). **Cloudflare Pages** (`agentflow-web`) is only the Next.js dashboard — a Pages deploy does **not** update webhook handling.

In **Cloudflare Dashboard → Workers → agenflow-back → Settings → Build** (not Pages), connect **GitHub `Auto-wiz/AgentFlow`**, branch **`main`**, root **`/`**:

- **Build:** `npm run cf-build-api` (or `npm ci && npm run check -w @agentflow/api`)
- **Deploy:** `cd apps/api && npx wrangler deploy`

Every push to **`main`** should create a row under **Workers → agenflow-back → Deployments**. If the last deploy is older than your latest commit, the GitHub→Cloudflare webhook may have stopped — use **Manage** on the Git connection to reconnect, or use the GitHub Actions deploy hook below.

Runtime secrets (`DATABASE_URL`, `STRIPE_*`, etc.) live under **Worker → Settings → Variables and Secrets**.

### GitHub Actions (reliable trigger on every push)

[`.github/workflows/api-worker.yml`](.github/workflows/api-worker.yml) runs the same check as Cloudflare, then **must** deploy via one of:

1. **Recommended — Deploy Hook** (reuses Cloudflare Builds; no API token in GitHub):  
   - Cloudflare → **agenflow-back → Builds → Deploy Hooks** → create hook for **`main`**  
   - GitHub → **Settings → Secrets → Actions** → `CLOUDFLARE_WORKER_DEPLOY_HOOK_URL` = hook URL  

2. **Alternative — wrangler from GitHub:**  
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`

Until one of these secrets exists, the workflow **fails on purpose** after check so you know the API did not deploy (Pages may still update separately).

Use **either** hook/wrangler from GitHub **or** rely only on Cloudflare git push builds — not both routinely (double deploy).

### Manual fallback

```sh
cd apps/api
npx wrangler deploy
```
