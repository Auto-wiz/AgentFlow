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

**GoHighLevel OAuth** on the Worker is still used to store installation tokens and (optionally) provision a user tied to a GHL `userId` — for example from **Settings → Integrations** or when you wire Marketplace install flows. It is **not** the primary app login. Configure **`GHL_OAUTH_START_URL`** (Installation URL from Developer Portal → your app → Advanced Settings → Auth) or **`GHL_INSTALL_URL`** as a fallback.

When OAuth completes successfully, the Worker issues a session JWT and redirects to **`/login#session=<jwt>`** (hash consumed by the web app). GHL-only provisioned users default to role `user`; set `role=admin` in Postgres when needed.

OAuth remains scoped to the **same HighLevel agency** already in your database: `agencies.ghl_agency_id` and/or `ghl_oauth_installations.company_id`. If both are empty, the **first** successful OAuth defines the tenant; later flows must use that same agency company id (otherwise the callback returns `wrong_agency`).

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
4. **GHL SaaS customer sync:** add the Marketplace **SaaS** scope to the Autowiz app and **reinstall OAuth** for the agency. The API calls **`GET /saas/get-saas-subscription/:ghlLocationId`** (GHL does not publish sample JSON). Admin endpoints:
   - **`POST /admin/client-charges/locations/:locationId/stripe/sync-from-ghl`**
   - **`POST /admin/client-charges/stripe/sync-from-ghl-all?limit=50`**
   - **`PATCH /admin/client-charges/locations/:locationId/stripe/customer-link`** with `{ "stripeCustomerId": "cus_…" }` to verify manually.
   If sync returns **`customer_id_missing`**, the response includes **`payloadShape`** (keys/types only, no secrets) so the parser can be extended.
5. In the app: **Dashboard → Client Charges → Location eligibility** → **Sync from GHL** or paste **`cus_…`** → **Verify customer** → **Add payment method** → enable the subaccount.

## Validation

```sh
npm run check
npm run build
```

For the Cloudflare Pages artifact, run:

```sh
npm run pages:build -w @agentflow/web
```
