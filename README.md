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

The **web app** always requires a stored workspace JWT: unauthenticated users are sent to `/connect` and the UI never falls back to anonymous “guest” or `x-viewer-key` from the browser.

The **API** can still accept `x-viewer-key` when `JWT_SECRET` is **not** set (for other clients or tools). Configure `JWT_SECRET` for normal production use.

Frontend variables:

```txt
NEXT_PUBLIC_API_BASE_URL=…
```

With `JWT_SECRET` set on the Worker, users sign in via GoHighLevel OAuth (`/connect` in the app). Configure the Worker with **`GHL_OAUTH_START_URL`**: paste the full **Installation URL** from Developer Portal → your app → **Advanced Settings → Auth** → show install link. That is the account-connect / consent screen (iframe-friendly) — not the public Marketplace browse experience. If you omit it, **`GHL_INSTALL_URL`** is built from pieces as a fallback.

After OAuth, the Worker provisions a workspace user from the Agency `userId`, issues a session JWT, and redirects back to **`/connect#session=<jwt>`**, which the web app stores locally. Roles default to `user`; set `role=admin` directly in Postgres when you want full admin tooling.

OAuth runs only for the **same HighLevel agency** already represented in your database: `agencies.ghl_agency_id` and/or `ghl_oauth_installations.company_id`. If both are empty, the **first** successful OAuth defines the tenant; later logins must use that same agency company id (otherwise the callback returns `wrong_agency` on `/connect`).

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
```

Install flow entrypoint:

```txt
https://api.agentflow.autowiz.net/oauth/gohighlevel/start
```

## Validation

```sh
npm run check
npm run build
```

For the Cloudflare Pages artifact, run:

```sh
npm run pages:build -w @agentflow/web
```
