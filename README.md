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

Production secrets are configured through Wrangler:

```sh
wrangler secret put DATABASE_URL
wrangler secret put GHL_WEBHOOK_SECRET
wrangler secret put GHL_API_TOKEN
wrangler secret put GHL_CLIENT_ID
wrangler secret put GHL_CLIENT_SECRET
```

Set these Worker variables in the Cloudflare dashboard or as `[vars]` in
`apps/api/wrangler.toml` for OAuth/install routing:

```txt
GHL_INSTALL_URL
GHL_OAUTH_REDIRECT_URI
GHL_OAUTH_USER_TYPE
FRONTEND_BASE_URL
ALLOW_UNSIGNED_GHL_WEBHOOKS
```

`ALLOW_UNSIGNED_GHL_WEBHOOKS` defaults to `false` and should stay disabled in
production. Set it to `true` only for temporary local testing without webhook
signatures.

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

## Database workflow (Neon + Drizzle)

Use these root scripts:

```sh
npm run db:generate
npm run db:migrate
npm run db:push
```

- `db:generate`: creates SQL migration files from schema changes.
- `db:migrate`: applies SQL migration files from `packages/db/migrations`.
- `db:push`: compares schema and pushes changes directly to Neon.

If Drizzle detects potentially unsafe changes, it will ask for confirmation and
requires an interactive terminal (TTY).

## Validation

```sh
npm run check
npm run build
npm run db:push
```

For the Cloudflare Pages artifact, run:

```sh
npm run pages:build -w @agentflow/web
```
