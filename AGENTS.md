# AgentFlow

## Cursor Cloud specific instructions

### Project overview

npm workspaces monorepo with four packages — see `README.md` for the full list.
The API (`apps/api`) is a Cloudflare Worker using Hono; the frontend (`apps/web`) is Next.js 14 on Cloudflare Pages.

### Running services

| Service | Command | Default port |
|---------|---------|-------------|
| API Worker | `npm run dev -w @agentflow/api` | 8787 |
| Frontend | `npm run dev -w @agentflow/web` | 3000 |

Pass `NEXT_PUBLIC_API_BASE_URL=http://localhost:8787` when starting the frontend so it can reach the local API.

Cloudflare Queues are emulated automatically by `wrangler dev` — no extra setup needed.

### Type checking / lint

```sh
npm run check          # runs tsc --noEmit across all workspaces
```

There is no separate ESLint config; `npm run check` is the only validation command.

### Building

```sh
npm run build          # dry-run deploy for API + next build for web
```

### Database

The app requires a Neon Postgres `DATABASE_URL`. Without it, the API starts and serves `/health` and `GET /webhooks/gohighlevel` normally, but any endpoint that touches the database (e.g. `/threads`) will return 500. The `@neondatabase/serverless` driver uses HTTP, so a standard local Postgres instance won't work as a drop-in replacement.

Migrations live in `packages/db/migrations/` and are applied with:

```sh
npm run db:migrate -w @agentflow/db   # requires DATABASE_URL
```

### Webhook testing without external GHL access

You can POST test payloads directly to `http://localhost:8787/webhooks/gohighlevel`. If `GHL_WEBHOOK_SECRET` is not set, signature verification is skipped. The endpoint returns `202 Accepted` even if DB persistence fails.

### Environment variables

Copy `.env.example` for reference. Only `DATABASE_URL` is truly required for full functionality; all GHL-related secrets degrade gracefully when absent.
