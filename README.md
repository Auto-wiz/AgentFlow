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

The API can enforce JWT sessions whenever `JWT_SECRET` is configured on the Worker. When it is absent, callers may keep using `x-viewer-key` legacy visibility (matching `NEXT_PUBLIC_LEGACY_VIEWER_KEY` on the frontend).

Frontend variables:

```txt
NEXT_PUBLIC_FORCE_WORKSPACE_LOGIN=true|false
NEXT_PUBLIC_LEGACY_VIEWER_KEY=default
```

With `JWT_SECRET` set on the Worker, users sign in via the GoHighLevel OAuth install flow (`/connect` in the app). After OAuth, the Worker provisions a workspace user from the Agency `userId`, issues a short-lived JWT, and redirects back to **`/connect#session=<jwt>`**, which the web app stores locally. Roles default to `user`; set `role=admin` directly in Postgres when you want full admin tooling.

Configure **Settings → Workspace admin** to choose default picked locations (`role=user`), and **Settings → Team selections** read-only overview of selections across everyone.

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
GHL_INSTALL_URL
GHL_APP_ID (optional, recommended for Marketplace v2 URLs)
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
